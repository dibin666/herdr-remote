'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');
const { HostConnector } = require('../src/host-connector');

function makeConnector(lockPath, overrides = {}) {
  return new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath,
    socketPath: path.join(path.dirname(lockPath), 'herdr.sock'),
    herdrCommand: process.execPath,
    terminalPalette: null,
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
    send(payload) { sent.push(JSON.parse(payload)); },
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
    assert.throws(() => second.acquireLock(), (error) => error.code === 'HOST_ALREADY_RUNNING');
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

// Issue #1: a missing Herdr used to reach execvp(3) inside the PTY child, which
// exited at once. The session_exit made the relay close the browser's socket,
// and the browser reconnected into the same failure forever.
test('a missing Herdr is reported as an error instead of a session that exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-missing-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    herdrCommand: path.join(directory, 'nowhere', 'herdr'),
    herdrLookup: { env: { PATH: '' }, home: directory, directories: [] },
  });
  t.after(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);

  connector.handleMessage(JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }));

  assert.equal(connector.sessions.size, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'herdr_not_found');
  assert.equal(sent[0].clientId, 'session-1');
  assert.match(sent[0].message, /HERDR_BIN_PATH/);
  // No session_exit: the relay never learns of an exit, so it never drops the
  // browser, so the browser never reconnects into the same broken start.
  assert.equal(sent.some((message) => message.type === 'session_exit'), false);
});

test('a Herdr installed after the connector started is picked up without a restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-late-'));
  const bin = path.join(directory, '.local', 'bin');
  const connector = makeConnector(path.join(directory, 'connector.lock'), {
    herdrCommand: 'herdr',
    herdrLookup: { env: { PATH: '' }, home: directory, directories: [bin] },
  });
  t.after(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.match(connector.ensureHerdrCommand() || '', /was not found/);

  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.equal(connector.ensureHerdrCommand(), null);
  assert.equal(connector.herdrCommand, path.join(bin, 'herdr'));
});

test('starts that keep dying immediately stop being reported as exits', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-fastfail-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.after(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);
  const brokenStart = () => connector.reportSessionExit({ id: 'session-1', startedAtMs: Date.now() }, 1);

  for (let attempt = 0; attempt < HostConnector.FAST_FAILURE_LIMIT - 1; attempt += 1) brokenStart();
  assert.deepEqual(sent.map((message) => message.type), ['session_exit', 'session_exit']);

  brokenStart();
  assert.equal(sent.at(-1).type, 'error');
  assert.equal(sent.at(-1).code, 'herdr_start_failed');
  assert.equal(sent.at(-1).clientId, 'session-1');

  // A session the user actually used clears the streak.
  connector.reportSessionExit({ id: 'session-2', startedAtMs: Date.now() - 60_000 }, 1);
  assert.equal(sent.at(-1).type, 'session_exit');
  assert.equal(connector.fastFailures, 0);
});

test('a quick clean exit is a finished session, not a broken start', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-quickexit-'));
  const connector = makeConnector(path.join(directory, 'connector.lock'));
  t.after(() => {
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sent = captureSocket(connector);

  for (let attempt = 0; attempt < HostConnector.FAST_FAILURE_LIMIT + 2; attempt += 1) {
    connector.reportSessionExit({ id: `session-${attempt}`, startedAtMs: Date.now() }, 0);
  }

  assert.deepEqual(new Set(sent.map((message) => message.type)), new Set(['session_exit']));
  assert.equal(connector.fastFailures, 0);
});

test('two sessions run side by side and are resized and stopped independently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-multisession-'));
  const lockPath = path.join(directory, 'connector.lock');
  const connector = makeConnector(lockPath);
  connector.herdrArgs = ['-e', 'setInterval(() => {}, 60_000)'];
  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(connector.socketPath, resolve));
  t.after(() => {
    socketServer.close();
    connector.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  captureSocket(connector);

  connector.handleMessage(JSON.stringify({ type: 'session_start', streamId: 'session-1', cols: 80, rows: 24 }));
  connector.handleMessage(JSON.stringify({ type: 'session_start', streamId: 'session-2', cols: 120, rows: 40 }));

  assert.equal(connector.sessions.size, 2);
  assert.ok(connector.sessions.has('session-1'));
  assert.ok(connector.sessions.has('session-2'));
  assert.equal(connector.sessions.get('session-1').cols, 80);
  assert.equal(connector.sessions.get('session-1').rows, 24);
  assert.equal(connector.sessions.get('session-2').cols, 120);
  assert.equal(connector.sessions.get('session-2').rows, 40);

  // Resize session-1 only
  connector.handleMessage(JSON.stringify({ type: 'resize', streamId: 'session-1', cols: 90, rows: 30 }));
  assert.equal(connector.sessions.get('session-1').cols, 90);
  assert.equal(connector.sessions.get('session-1').rows, 30);
  assert.equal(connector.sessions.get('session-2').cols, 120);
  assert.equal(connector.sessions.get('session-2').rows, 40);

  // Stop session-1 only
  connector.handleMessage(JSON.stringify({ type: 'session_stop', streamId: 'session-1' }));
  assert.equal(connector.sessions.has('session-1'), false);
  assert.equal(connector.sessions.has('session-2'), true);
  assert.equal(connector.sessions.size, 1);
});

