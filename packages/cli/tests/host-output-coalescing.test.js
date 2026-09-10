'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');
const { unpackStreamFrame } = require('herdr-remote-relay/protocol');
const { HostConnector } = require('../src/host-connector');

test('host connector coalesces multiple onData chunks emitted in the same tick into one frame', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-coalesce-'));
  const lockPath = path.join(directory, 'connector.lock');
  const socketPath = path.join(directory, 'herdr.sock');

  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(socketPath, resolve));

  let capturedOnData = null;
  class MockPty {
    constructor() {
      this.terminal = { pid: 9999 };
    }
    start({ onData }) {
      capturedOnData = onData;
      return this;
    }
    kill() {}
  }

  const connector = new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath,
    socketPath,
    herdrCommand: process.execPath,
    terminalPalette: null,
    PtySession: MockPty,
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 60_000 },
    },
  });

  t.after(() => {
    connector.stop();
    socketServer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sentRaw = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sentRaw.push(payload);
    },
    close() {},
  };

  connector.startSession({ type: 'session_start', streamId: 'session-batch-1', cols: 80, rows: 24 });
  assert.ok(capturedOnData, 'PtySession onData callback should be registered');

  // Emit two onData chunks in the exact same event loop tick
  capturedOnData(Buffer.from('first-chunk-', 'utf8'));
  capturedOnData(Buffer.from('second-chunk', 'utf8'));

  // Before setImmediate executes, no output frame has been dispatched to the socket
  const sentFramesBeforeFlush = sentRaw.filter((p) => Buffer.isBuffer(p));
  assert.equal(sentFramesBeforeFlush.length, 0);

  // Wait for setImmediate to execute
  await new Promise((resolve) => setImmediate(resolve));

  // Exactly one binary stream frame should have been sent, containing the concatenation
  const binaryFrames = sentRaw.filter((p) => Buffer.isBuffer(p));
  assert.equal(binaryFrames.length, 1);

  const unpacked = unpackStreamFrame(binaryFrames[0]);
  assert.equal(unpacked.type, 'output');
  assert.equal(unpacked.streamId, 'session-batch-1');
  assert.equal(unpacked.payload.toString('utf8'), 'first-chunk-second-chunk');
});

test('stopping a session clears pending output and scheduled flush', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-host-stop-'));
  const lockPath = path.join(directory, 'connector.lock');
  const socketPath = path.join(directory, 'herdr.sock');

  const socketServer = net.createServer();
  await new Promise((resolve) => socketServer.listen(socketPath, resolve));

  let capturedOnData = null;
  class MockPty {
    constructor() {
      this.terminal = { pid: 9999 };
    }
    start({ onData }) {
      capturedOnData = onData;
      return this;
    }
    kill() {}
  }

  const connector = new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath,
    socketPath,
    herdrCommand: process.execPath,
    terminalPalette: null,
    PtySession: MockPty,
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 60_000 },
    },
  });

  t.after(() => {
    connector.stop();
    socketServer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const sentRaw = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sentRaw.push(payload);
    },
    close() {},
  };

  connector.startSession({ type: 'session_start', streamId: 'session-cancel-1', cols: 80, rows: 24 });
  capturedOnData(Buffer.from('abandoned-output', 'utf8'));

  // Stop session before flush executes
  connector.stopSession('session-cancel-1');

  await new Promise((resolve) => setImmediate(resolve));

  const binaryFrames = sentRaw.filter((p) => Buffer.isBuffer(p));
  assert.equal(binaryFrames.length, 0);
});
