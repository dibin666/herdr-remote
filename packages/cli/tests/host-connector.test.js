'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');
const { HostConnector } = require('../src/host-connector');

function makeConnector(lockPath) {
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
  });
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
  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { sent.push(JSON.parse(payload)); },
    close() {},
  };
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

  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { sent.push(JSON.parse(payload)); },
    close() {},
  };

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

