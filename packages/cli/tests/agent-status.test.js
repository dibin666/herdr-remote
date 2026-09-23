'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AGENT_STATUSES,
  emptySummary,
  sameSummary,
  summarizeAgents,
} = require('../src/agent-status');
const { requestHerdr } = require('../src/herdr-api');

/** One entry as `session.snapshot` reports it. */
function agent(paneId, status, extra = {}) {
  return {
    pane_id: paneId,
    workspace_id: 'wA',
    agent: 'claude',
    agent_status: status,
    terminal_title_stripped: 'Claude Code',
    ...extra,
  };
}

test('a snapshot becomes counts a status bar can show', () => {
  const summary = summarizeAgents({
    agents: [agent('p1', 'working'), agent('p2', 'blocked'), agent('p3', 'working')],
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.counts.working, 2);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.counts.idle, 0);
});

// The list is capped, so what survives the cap has to be what a person came for.
test('agents are ordered by how much they want attention', () => {
  const summary = summarizeAgents({
    agents: [agent('p1', 'idle'), agent('p2', 'working'), agent('p3', 'blocked'), agent('p4', 'done')],
  });

  assert.deepEqual(summary.agents.map((entry) => entry.status), ['blocked', 'done', 'working', 'idle']);
});

test('a status Herdr has not taught us is unknown, not a new column', () => {
  const summary = summarizeAgents({ agents: [agent('p1', 'reticulating')] });

  assert.equal(summary.counts.unknown, 1);
  assert.deepEqual(Object.keys(summary.counts).sort(), [...AGENT_STATUSES].sort());
});

test('a title from a remote program is stripped and clamped', () => {
  const summary = summarizeAgents({
    agents: [agent('p1', 'working', { terminal_title_stripped: `we\u001B[31mird\ntitle ${'x'.repeat(100)}` })],
  });

  const { title } = summary.agents[0];
  assert.ok(title.length <= 48);
  assert.ok(!/[\u0000-\u001F]/.test(title));
});

test('nonsense in place of a snapshot is an empty summary, not a throw', () => {
  assert.deepEqual(summarizeAgents(null), emptySummary());
  assert.deepEqual(summarizeAgents({ agents: 'no' }), emptySummary());
  assert.equal(summarizeAgents({ agents: [{ no: 'pane id' }] }).total, 0);
});

test('an unchanged summary is recognised, so nothing is sent for nothing', () => {
  const first = summarizeAgents({ agents: [agent('p1', 'working')] });
  const same = summarizeAgents({ agents: [agent('p1', 'working')] });
  const moved = summarizeAgents({ agents: [agent('p1', 'blocked')] });

  assert.equal(sameSummary(first, same), true);
  assert.equal(sameSummary(first, moved), false);
  assert.equal(sameSummary(null, first), false);
  assert.equal(sameSummary(null, null), true);
});

test('the focused pane and its agent are carried even without a tracked agent', () => {
  const summary = summarizeAgents({
    focused_pane_id: 'wA:p2',
    panes: [{ pane_id: 'wA:p2', agent: 'pi' }],
    agents: [agent('wA:p1', 'working')],
  });

  assert.equal(summary.focusedPaneId, 'wA:p2');
  assert.equal(summary.focusedAgent, 'pi');
  assert.equal(sameSummary(summary, summarizeAgents({
    focused_pane_id: 'wA:p3',
    panes: [{ pane_id: 'wA:p3', agent: 'pi' }],
    agents: [agent('wA:p1', 'working')],
  })), false);
  assert.equal(summarizeAgents({
    focused_pane_id: 'wA:p1',
    panes: [],
    agents: [agent('wA:p1', 'working', { agent: 'claude-code' })],
  }).focusedAgent, 'claude-code');
});

test('falls back to focused pane and agent markers when the top-level focus ID is absent', () => {
  const paneSummary = summarizeAgents({
    panes: [{ pane_id: 'wA:p2', agent: 'pi', focused: true }],
    agents: [agent('wA:p1', 'idle')],
  });
  assert.equal(paneSummary.focusedPaneId, 'wA:p2');
  assert.equal(paneSummary.focusedAgent, 'pi');

  const agentSummary = summarizeAgents({
    agents: [agent('wA:p3', 'working', { focused: true })],
  });
  assert.equal(agentSummary.focusedPaneId, 'wA:p3');
  assert.equal(agentSummary.focusedAgent, 'claude');

  const shellSummary = summarizeAgents({
    focused_pane_id: 'wA:p4',
    panes: [{ pane_id: 'wA:p4' }],
    agents: [agent('wA:p3', 'working', { focused: false })],
  });
  assert.equal(shellSummary.focusedPaneId, 'wA:p4');
  assert.equal(shellSummary.focusedAgent, null);
});

/**
 * A stand-in for Herdr's socket: answers one request per connection and hangs
 * up, which is what the real one does and the reason `requestHerdr` connects
 * per question. `connections` counts them.
 */
function fakeHerdrSocket(t, handler) {
  const socketPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-api-')),
    'herdr.sock',
  );
  const state = { socketPath, connections: 0 };
  const server = net.createServer((connection) => {
    state.connections += 1;
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handler(JSON.parse(buffer.slice(0, newline)), connection);
      buffer = '';
    });
  });
  t.after(() => {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(state)));
}

/** Answer, then hang up the way Herdr does. */
function answer(connection, payload) {
  connection.end(`${JSON.stringify(payload)}\n`);
}

test('one question, one connection, newline-delimited JSON', async (t) => {
  const herdr = await fakeHerdrSocket(t, (request, connection) => {
    assert.equal(request.method, 'session.snapshot');
    assert.equal(typeof request.id, 'string');
    answer(connection, { id: request.id, result: { snapshot: { agents: [agent('p1', 'blocked')] } } });
  });

  const first = await requestHerdr(herdr.socketPath, 'session.snapshot', {});
  const second = await requestHerdr(herdr.socketPath, 'session.snapshot', {});

  assert.equal(summarizeAgents(first.snapshot).counts.blocked, 1);
  assert.equal(summarizeAgents(second.snapshot).counts.blocked, 1);
  // The point of the rewrite: two questions, two connections, no loop between.
  assert.equal(herdr.connections, 2);
});

test('a Herdr subscription parses the live event envelope and can be closed', async (t) => {
  const subscriptions = [
    { type: 'pane.focused' },
    { type: 'tab.focused' },
    { type: 'workspace.focused' },
    { type: 'pane.agent_detected' },
  ];
  const herdr = await fakeHerdrSocket(t, (request, connection) => {
    assert.equal(request.method, 'events.subscribe');
    assert.deepEqual(request.params.subscriptions, subscriptions);
    connection.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
    connection.write(`${JSON.stringify({
      event: 'pane_focused',
      data: { type: 'pane_focused', pane_id: 'w1:p1', workspace_id: 'w1' },
    })}\n`);
  });

  const { subscribeHerdr } = require('../src/herdr-api');
  let closeCount = 0;
  const event = await new Promise((resolve) => {
    const subscription = subscribeHerdr(herdr.socketPath, subscriptions, (message) => {
      closeCount += 1;
      resolve(message);
      subscription.close();
    });
  });

  assert.deepEqual(event, {
    event: 'pane_focused',
    data: { type: 'pane_focused', pane_id: 'w1:p1', workspace_id: 'w1' },
  });
  assert.equal(closeCount, 1);
});

test('an acknowledged subscription resets the reconnect backoff', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-subscribe-retry-'));
  const socketPath = path.join(directory, 'herdr.sock');
  let connectionCount = 0;
  let secondCloseAt = 0;
  let thirdConnectedAt = 0;
  let resolveThird;
  let subscription;
  const thirdConnection = new Promise((resolve) => { resolveThird = resolve; });
  const server = net.createServer((connection) => {
    connectionCount += 1;
    const current = connectionCount;
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      if (current === 1) {
        connection.end();
      } else if (current === 2) {
        connection.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
        setTimeout(() => {
          secondCloseAt = Date.now();
          connection.end();
        }, 20);
      } else if (current === 3) {
        thirdConnectedAt = Date.now();
        resolveThird();
      }
    });
  });
  t.after(() => {
    if (subscription) subscription.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const { subscribeHerdr } = require('../src/herdr-api');
  subscription = subscribeHerdr(socketPath, [{ type: 'pane.focused' }], () => {}, {
    retryBaseMs: 200,
    retryMaxMs: 600,
  });
  let timeout;
  try {
    await Promise.race([
      thirdConnection,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('subscription did not reconnect')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    subscription.close();
  }

  assert.equal(connectionCount, 3);
  assert.ok(thirdConnectedAt - secondCloseAt < 350,
    `expected base backoff after acknowledgement; elapsed ${thirdConnectedAt - secondCloseAt}ms`);
});

test('an error answer rejects with the code Herdr gave', async (t) => {
  const herdr = await fakeHerdrSocket(t, (request, connection) => {
    answer(connection, {
      id: request.id,
      error: { code: 'invalid_request', message: 'missing field `pane_id`' },
    });
  });

  await assert.rejects(
    () => requestHerdr(herdr.socketPath, 'session.snapshot', {}),
    (error) => error.code === 'invalid_request',
  );
});

test('a server that hangs up without answering rejects rather than hanging', async (t) => {
  const herdr = await fakeHerdrSocket(t, (_request, connection) => connection.end());

  await assert.rejects(
    () => requestHerdr(herdr.socketPath, 'session.snapshot', {}),
    /closed before answering/,
  );
});

test('a socket that is not there rejects rather than hanging', async () => {
  await assert.rejects(() => requestHerdr('/nonexistent/herdr.sock', 'session.snapshot', {}));
});

test('a server that never answers gives up on its own', async (t) => {
  const herdr = await fakeHerdrSocket(t, () => {});

  await assert.rejects(
    () => requestHerdr(herdr.socketPath, 'session.snapshot', {}, { timeout: 100 }),
    /did not answer/,
  );
});

test('a line that is not JSON is refused, not half-parsed', async (t) => {
  const herdr = await fakeHerdrSocket(t, (_request, connection) => connection.end('not json\n'));

  await assert.rejects(
    () => requestHerdr(herdr.socketPath, 'session.snapshot', {}),
    /not JSON/,
  );
});
