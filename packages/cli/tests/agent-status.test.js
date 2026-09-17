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
