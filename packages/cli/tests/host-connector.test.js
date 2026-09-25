// No test here may ask npm whether a newer herdr-remote exists.
process.env.HERDR_REMOTE_UPDATE_CHECK = '0';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { HostConnector } from '../src/connector/host-connector.js';
import { FAST_FAILURE_LIMIT } from '../src/connector/sessions.js';
import {
  packStreamFrameV2,
  unpackStreamFrame,
  FRAME_TYPE_INPUT,
  FRAME_TYPE_OUTPUT,
  FRAME_V2_MAGIC,
} from 'herdr-remote-relay/protocol';

function makeConnector(lockPath, overrides = {}) {
  return new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath,
    socketPath: path.join(path.dirname(lockPath), 'herdr.sock'),
    herdrCommand: process.execPath,
    terminalPalette: null,
    terminalFont: null,
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 10 },
    },
    ...overrides,
  });
}

/** Collect what the connector would have put on the wire. */
function captureSocket(connector) {
  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };
  return sent;
}

test('host connector uses a stale-safe single-instance lock', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-lock-'));
  const lockPath = path.join(directory, 'connector.lock');
  const first = makeConnector(lockPath);
  const second = makeConnector(lockPath);
  try {
    first.acquireLock();
    assert.throws(
      () => second.acquireLock(),
      (error) => error.code === 'HOST_ALREADY_RUNNING',
    );
    first.releaseLock();
    second.acquireLock();
  } finally {
    first.releaseLock();
    second.releaseLock();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('business heartbeats stop while no browser is attached', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-heartbeat-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  const sent = captureSocket(connector);
  try {
    connector.setClientCount(0);
    assert.deepEqual(sent, []);
    connector.setClientCount(1);
    assert.equal(sent[0].type, 'heartbeat');
    assert.ok(connector.heartbeatTimer);
    connector.setClientCount(0);
    assert.equal(sent.at(-1).type, 'heartbeat');
    assert.equal(connector.heartbeatTimer, null);
  } finally {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agent focus events trigger a debounced snapshot read and stop with the watcher', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-agent-events-'));
  let onEvent;
  let closeCount = 0;
  let reads = 0;
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    subscribeHerdr(_socketPath, subscriptions, callback) {
      assert.deepEqual(subscriptions, [
        { type: 'pane.focused' },
        { type: 'tab.focused' },
        { type: 'workspace.focused' },
        { type: 'pane.agent_detected' },
      ]);
      onEvent = callback;
      return {
        close() {
          closeCount += 1;
        },
      };
    },
    async requestHerdr() {
      reads += 1;
      const paneId = `w1:p${reads}`;
      const agent = reads === 1 ? 'pi' : 'claude';
      return {
        snapshot: {
          focused_pane_id: paneId,
          panes: [{ pane_id: paneId, agent }],
          agents: [
            {
              pane_id: paneId,
              workspace_id: 'w1',
              agent,
              agent_status: 'working',
              focused: true,
            },
          ],
        },
      };
    },
  });
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);

  connector.setClientCount(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'starting the watcher reads one initial snapshot');
  assert.equal(sent.find((message) => message.type === 'agent_status')?.focusedAgent, 'pi');

  onEvent({ event: 'pane_focused', data: { pane_id: 'w1:p1' } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reads, 2, 'a focus event refreshes the snapshot after the debounce');

  assert.deepEqual(
    sent
      .filter((message) => message.type === 'agent_status')
      .map((message) => message.focusedAgent),
    ['pi', 'claude'],
  );
  connector.agents.stop();
  assert.equal(closeCount, 1, 'stopping the watcher closes its subscription');
  onEvent({ event: 'pane_focused', data: { pane_id: 'w1:p2' } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reads, 2, 'events after stop do not start another read');
});

// Issue #1: a missing Herdr used to reach execvp(3) inside the PTY child, which
// exited at once. The session_exit made the relay close the browser's socket,
// and the browser reconnected into the same failure forever.
test('a missing Herdr is reported as an error instead of a session that exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-missing-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    herdrCommand: path.join(directory, 'nowhere', 'herdr'),
    herdrLookup: { env: { PATH: '' }, home: directory, directories: [] },
  });
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);

  connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );

  assert.equal(connector.sessions.byStream.size, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'herdr_not_found');
  assert.equal(sent[0].clientId, 'session-1');
  assert.match(sent[0].message, /HERDR_BIN_PATH/);
  // No session_exit: the relay never learns of an exit, so it never drops the
  // browser, so the browser never reconnects into the same broken start.
  assert.equal(
    sent.some((message) => message.type === 'session_exit'),
    false,
  );
});

test('a Herdr installed after the connector started is picked up without a restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-late-'));
  const bin = path.join(directory, '.local', 'bin');
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    herdrCommand: 'herdr',
    herdrLookup: { env: { PATH: '' }, home: directory, directories: [bin] },
  });
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.match(connector.sessions.ensureHerdrCommand() || '', /was not found/);

  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.equal(connector.sessions.ensureHerdrCommand(), null);
  assert.equal(connector.sessions.herdrCommand, path.join(bin, 'herdr'));
});

test('starts that keep dying immediately stop being reported as exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-fastfail-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);
  const brokenStart = () =>
    connector.sessions.reportExit({ id: 'session-1', startedAtMs: Date.now() }, 1);

  for (let attempt = 0; attempt < FAST_FAILURE_LIMIT - 1; attempt += 1) brokenStart();
  assert.deepEqual(
    sent.map((message) => message.type),
    ['session_exit', 'session_exit'],
  );

  brokenStart();
  assert.equal(sent.at(-1).type, 'error');
  assert.equal(sent.at(-1).code, 'herdr_start_failed');
  assert.equal(sent.at(-1).clientId, 'session-1');

  // A session the user actually used clears the streak.
  connector.sessions.reportExit({ id: 'session-2', startedAtMs: Date.now() - 60_000 }, 1);
  assert.equal(sent.at(-1).type, 'session_exit');
  assert.equal(connector.sessions.fastFailures, 0);
});

test('a quick clean exit is a finished session, not a broken start', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-quickexit-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);

  for (let attempt = 0; attempt < FAST_FAILURE_LIMIT + 2; attempt += 1) {
    connector.sessions.reportExit({ id: `session-${attempt}`, startedAtMs: Date.now() }, 0);
  }

  assert.deepEqual(new Set(sent.map((message) => message.type)), new Set(['session_exit']));
  assert.equal(connector.sessions.fastFailures, 0);
});

test('two sessions run side by side and are resized and stopped independently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-multisession-'));
  const lockPath = path.join(directory, 'connector.lock');
  const connector = makeConnector(lockPath);
  connector.sessions.herdrArgs = ['-e', 'setInterval(() => {}, 60_000)'];
  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(connector.socketPath, resolve));
  t.onTestFinished(() => {
    socketServer.close();
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  captureSocket(connector);

  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-2', cols: 120, rows: 40 }),
  );

  assert.equal(connector.sessions.byStream.size, 2);
  assert.ok(connector.sessions.byStream.has('session-1'));
  assert.ok(connector.sessions.byStream.has('session-2'));
  assert.equal(connector.sessions.byStream.get('session-1').cols, 80);
  assert.equal(connector.sessions.byStream.get('session-1').rows, 24);
  assert.equal(connector.sessions.byStream.get('session-2').cols, 120);
  assert.equal(connector.sessions.byStream.get('session-2').rows, 40);

  // Resize session-1 only
  connector.handleMessage(
    JSON.stringify({ type: 'resize', streamId: 'session-1', cols: 90, rows: 30 }),
  );
  assert.equal(connector.sessions.byStream.get('session-1').cols, 90);
  assert.equal(connector.sessions.byStream.get('session-1').rows, 30);
  assert.equal(connector.sessions.byStream.get('session-2').cols, 120);
  assert.equal(connector.sessions.byStream.get('session-2').rows, 40);

  // Stop session-1 only
  connector.handleMessage(JSON.stringify({ type: 'session_stop', streamId: 'session-1' }));
  assert.equal(connector.sessions.byStream.has('session-1'), false);
  assert.equal(connector.sessions.byStream.has('session-2'), true);
  assert.equal(connector.sessions.byStream.size, 1);
});

test('host connector handles v2 binary frames and negotiation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-v2-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  connector.sessions.herdrArgs = ['-e', 'setInterval(() => {}, 60_000)'];
  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(connector.socketPath, resolve));
  t.onTestFinished(() => {
    socketServer.close();
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sentBinary = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      if (Buffer.isBuffer(payload)) sentBinary.push(payload);
    },
    close() {},
  };

  // Start session with streamIndex: 7
  await connector.handleMessage(
    JSON.stringify({
      type: 'session_start',
      streamId: 'v2-stream',
      streamIndex: 7,
      cols: 80,
      rows: 24,
    }),
  );

  assert.equal(connector.sessions.byStream.size, 1);
  assert.equal(connector.sessions.streamIndexToId.get(7), 'v2-stream');

  const session = connector.sessions.byStream.get('v2-stream');
  let writtenInput = null;
  session.pty.write = (data) => {
    writtenInput = data;
  };

  // Relay sends v2 input frame with streamIndex 7
  const inputPayload = Buffer.from('hello-v2-input', 'utf8');
  const v2Frame = packStreamFrameV2(FRAME_TYPE_INPUT, 7, inputPayload);
  connector.handleMessage(v2Frame, true);
  assert.deepEqual(writtenInput, inputPayload);

  // Trigger output flush from session PTY output
  session.pendingOutput.push(Buffer.from('hello-v2-output', 'utf8'));
  // Simulate session flush timer
  await new Promise((resolve) => {
    session.flushImmediate = setImmediate(() => {
      if (session.pendingOutput.length > 0) {
        const payload = Buffer.concat(session.pendingOutput);
        session.pendingOutput = [];
        const frame =
          typeof session.streamIndex === 'number'
            ? packStreamFrameV2(FRAME_TYPE_OUTPUT, session.streamIndex, payload)
            : packStreamFrame('output', session.id, payload);
        connector.ws.send(frame);
      }
      resolve();
    });
  });

  assert.equal(sentBinary.length, 1);
  assert.equal(sentBinary[0][0], FRAME_V2_MAGIC);
  const unpacked = unpackStreamFrame(sentBinary[0]);
  assert.equal(unpacked.version, 2);
  assert.equal(unpacked.streamIndex, 7);
  assert.deepEqual(unpacked.payload, Buffer.from('hello-v2-output', 'utf8'));

  // Stop session cleans up streamIndex mapping
  connector.sessions.stop('v2-stream');
  assert.equal(connector.sessions.byStream.size, 0);
  assert.equal(connector.sessions.streamIndexToId.has(7), false);
});

test('clientCount=0 sends transport keepalive heartbeat and ping', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-keepalive-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sent = [];
  let pingCount = 0;
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    ping() {
      pingCount += 1;
    },
    close() {},
    terminate() {},
  };

  connector.handleMessage(JSON.stringify({ type: 'host_ready', clientCount: 0 }));
  assert.ok(connector.keepaliveTimer, 'keepaliveTimer should be active');
  assert.equal(
    connector.heartbeatTimer,
    null,
    'heartbeatTimer should be null when clientCount is 0',
  );

  // Trigger keepalive tick
  connector.tickKeepalive();
  assert.equal(pingCount, 1, 'ping should be sent');
  assert.equal(sent.length, 1, 'idle heartbeat should be sent');
  assert.equal(sent[0].type, 'heartbeat');
  assert.deepEqual(sent[0].load, {});
  assert.deepEqual(sent[0].ptys, []);

  // When clientCount becomes 1, keepalive tick does not duplicate full business heartbeat
  connector.setClientCount(1);
  assert.ok(connector.heartbeatTimer, 'heartbeatTimer should be active when clientCount > 0');
  const sentCountBefore = sent.length;
  connector.ws.isAlive = true;
  connector.tickKeepalive();
  assert.equal(pingCount, 2, 'ping should be sent on keepalive tick');
  assert.equal(
    sent.length,
    sentCountBefore,
    'no duplicate heartbeat from keepalive tick when active',
  );
});

test('keepalive timer lifecycle: start, stop, close, and replacement isolation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-timer-lifecycle-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const mockWs = {
    readyState: WebSocket.OPEN,
    send() {},
    ping() {},
    close() {},
    terminate() {},
  };
  connector.ws = mockWs;

  // 1. host_ready starts keepalive timer
  connector.handleMessage(JSON.stringify({ type: 'host_ready', clientCount: 0 }));
  assert.ok(connector.keepaliveTimer);

  // 2. stop() clears keepalive timer
  connector.stop();
  assert.equal(connector.keepaliveTimer, null);

  // 3. Reconnecting and receiving host_ready starts a new timer
  connector.stopping = false;
  connector.ws = mockWs;
  connector.handleMessage(JSON.stringify({ type: 'host_ready', clientCount: 0 }));
  const activeTimer = connector.keepaliveTimer;
  assert.ok(activeTimer);

  // 4. Stale close from an older socket does not clear the new timer
  const oldWs = { ...mockWs };
  connector.ws = mockWs;
  if (connector.ws === oldWs) connector.stopKeepalive();
  assert.equal(connector.keepaliveTimer, activeTimer, 'old socket close must not clear new timer');

  // 5. Current socket closing clears keepalive timer
  connector.stopKeepalive();
  assert.equal(connector.keepaliveTimer, null);
});

test('watchdog terminates socket and schedules reconnect when pong is missed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-watchdog-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let terminated = false;
  let closeListener = null;
  const mockWs = {
    readyState: WebSocket.OPEN,
    isAlive: true,
    send() {},
    ping() {},
    close() {},
    terminate() {
      terminated = true;
      this.readyState = WebSocket.CLOSED;
      if (closeListener) closeListener(1006, '');
    },
    on(event, handler) {
      if (event === 'close') closeListener = handler;
    },
  };

  connector.ws = mockWs;
  mockWs.on('close', () => {
    if (connector.ws !== mockWs) return;
    connector.ws = null;
    connector.stopKeepalive();
    connector.scheduleReconnect();
  });

  connector.startKeepalive();
  assert.ok(connector.keepaliveTimer);

  // Cycle 1: tick sends ping, marks isAlive = false
  connector.tickKeepalive();
  assert.equal(mockWs.isAlive, false);
  assert.equal(terminated, false);

  // No pong arrives! Cycle 2: isAlive is still false, watchdog terminates
  connector.tickKeepalive();
  assert.equal(terminated, true, 'socket should be terminated by watchdog');
  assert.equal(connector.ws, null, 'ws should be cleared after terminate');
  assert.equal(connector.keepaliveTimer, null, 'keepalive timer should be cleared');
  assert.ok(connector.reconnectTimer, 'reconnect timer should be scheduled');
});

/** A PTY that records how it was started instead of running anything. */
function recordingPty(started) {
  return class RecordingPty {
    constructor(options) {
      this.options = options;
      this.command = options.command;
      this.cwd = options.cwd;
      this.terminal = { pid: 1 };
    }
    start({ cols, rows }) {
      started.push({ cols, rows, args: this.options.args, socketPath: this.options.socketPath });
      return this;
    }
    resize() {}
    kill() {}
  };
}

function herdrLessConnector(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-noherdr-'));
  const started = [];
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    PtySession: recordingPty(started),
    herdrArgs: ['--session', 'work'],
    ...overrides,
  });
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { connector, started, sent: captureSocket(connector) };
}

test('a window waits for a Herdr that is not running instead of starting one itself', async (t) => {
  const { connector, started, sent } = herdrLessConnector(t);

  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );

  // No client was launched: a `herdr` client with no server starts a server of
  // its own, inside this service, without anyone having agreed to it.
  assert.deepEqual(started, []);
  assert.equal(connector.sessions.waitingForHerdr.has('session-1'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'herdr_not_running');
  assert.equal(sent[0].clientId, 'session-1');
});

test('a socket file with nothing behind it counts as a stopped Herdr', async (t) => {
  const { connector, started, sent } = herdrLessConnector(t, {
    probeHerdr: async () => ({ state: 'stopped', stale: true }),
  });
  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(connector.socketPath, resolve));
  t.onTestFinished(() => socketServer.close());

  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );

  assert.deepEqual(started, []);
  assert.equal(sent.at(-1).code, 'herdr_not_running');
});

test("starting Herdr uses this workstation's own settings and then opens every waiting window", async (t) => {
  const calls = [];
  const { connector, started, sent } = herdrLessConnector(t, {
    ensureHerdr: async (options) => {
      calls.push(options);
      return { started: true };
    },
  });

  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-2', cols: 120, rows: 40 }),
  );
  // A window resized while it waited opens at its latest size.
  connector.handleMessage(
    JSON.stringify({ type: 'resize', streamId: 'session-1', cols: 100, rows: 30 }),
  );

  // Whatever the message claims about hosts or sockets is not an input.
  await connector.handleMessage(
    JSON.stringify({
      type: 'herdr_start',
      streamId: 'session-1',
      hostId: 'somebody-else',
      socketPath: '/home/somebody-else/.config/herdr/herdr.sock',
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].socketPath, connector.socketPath);
  assert.deepEqual(calls[0].args, ['--session', 'work']);
  assert.equal(calls[0].command, connector.sessions.herdrCommand);
  assert.deepEqual(
    started.map(({ cols, rows }) => ({ cols, rows })),
    [
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
    ],
  );
  assert.equal(connector.sessions.waitingForHerdr.size, 0);
  assert.deepEqual(
    sent.filter((message) => message.type === 'session_ready').map((message) => message.clientId),
    ['session-1', 'session-2'],
  );
});

test('windows asking at the same time share one Herdr start', async (t) => {
  let calls = 0;
  let release;
  const { connector, started } = herdrLessConnector(t, {
    ensureHerdr: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ started: true });
      });
    },
  });
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-2', cols: 80, rows: 24 }),
  );

  const first = connector.handleMessage(
    JSON.stringify({ type: 'herdr_start', streamId: 'session-1' }),
  );
  const second = connector.handleMessage(
    JSON.stringify({ type: 'herdr_start', streamId: 'session-2' }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(started.length, 2);
});

test('a Herdr that fails to start is reported to the window that asked', async (t) => {
  const { connector, started, sent } = herdrLessConnector(t, {
    ensureHerdr: async () => {
      throw new Error('Herdr server exited (code 1) before opening the socket.');
    },
  });
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );

  await connector.handleMessage(JSON.stringify({ type: 'herdr_start', streamId: 'session-1' }));

  assert.deepEqual(started, []);
  assert.equal(sent.at(-1).code, 'herdr_start_failed');
  assert.equal(sent.at(-1).clientId, 'session-1');
  assert.match(sent.at(-1).message, /exited \(code 1\)/);
  // Still waiting: the window can ask again.
  assert.equal(connector.sessions.waitingForHerdr.has('session-1'), true);
});

test('a window closed while it waited is not opened when Herdr starts', async (t) => {
  const { connector, started } = herdrLessConnector(t, {
    ensureHerdr: async () => ({ started: true }),
  });
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );
  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-2', cols: 80, rows: 24 }),
  );
  connector.handleMessage(JSON.stringify({ type: 'session_stop', streamId: 'session-1' }));

  await connector.handleMessage(JSON.stringify({ type: 'herdr_start', streamId: 'session-2' }));

  assert.equal(started.length, 1);
  assert.deepEqual([...connector.sessions.byStream.keys()], ['session-2']);
});

test('Herdr starts with the connector only when the user switched that on', async (t) => {
  for (const autoStart of [false, true]) {
    let calls = 0;
    const { connector } = herdrLessConnector(t, {
      ensureHerdr: async () => {
        calls += 1;
        return { started: true };
      },
      config: {
        herdr: { args: [], cwd: process.cwd(), socketPath: null, autoStart },
        cleanup: { heartbeatIntervalMs: 10 },
      },
    });
    connector.start();
    await new Promise((resolve) => setImmediate(resolve));
    connector.stop();
    assert.equal(calls, autoStart ? 1 : 0, `autoStart=${autoStart}`);
  }
});

function updateConnector(t, { latest = '0.3.0', installed = '0.2.16', ok = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-update-'));
  let checks = 0;
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    PtySession: recordingPty([]),
    runningVersion: '0.2.16',
    readInstalledVersion: () => installed,
    checkUpdate: async () => {
      checks += 1;
      return ok ? { ok: true, latest } : { ok: false };
    },
  });
  t.onTestFinished(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { connector, sent: captureSocket(connector), checks: () => checks };
}

test('opening a window tells every window whether a newer herdr-remote is out', async (t) => {
  const { connector, sent } = updateConnector(t);

  await connector.handleMessage(
    JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }),
  );
  await connector.updates.pending;

  const status = sent.find((message) => message.type === 'update_status');
  assert.deepEqual(status, {
    type: 'update_status',
    current: '0.2.16',
    installed: '0.2.16',
    latest: '0.3.0',
    updateAvailable: true,
    restartPending: false,
  });
  // A fact about the workstation, not about one window.
  assert.equal(Object.hasOwn(status, 'clientId'), false);
});

test('an update installed on disk but not restarted into says so', async (t) => {
  const { connector, sent } = updateConnector(t, { installed: '0.3.0' });
  await connector.updates.report();
  const status = sent.find((message) => message.type === 'update_status');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.restartPending, true);
});

test('windows opening together ask npm once, and again a minute later', async (t) => {
  const { connector, checks } = updateConnector(t);
  const now = Date.now();
  await connector.updates.report({ now });
  await connector.updates.report({ now: now + 1_000 });
  assert.equal(checks(), 1);
  await connector.updates.report({ now: now + 61_000 });
  assert.equal(checks(), 2);
});

test('a check that fails says nothing', async (t) => {
  const { connector, sent } = updateConnector(t, { ok: false });
  await connector.updates.report();
  assert.equal(
    sent.some((message) => message.type === 'update_status'),
    false,
  );
});
