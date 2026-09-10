'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { RelayServer } = require('../src/relay-server');
const { loadRelayConfig } = require('../src/relay-config');
const { packStreamFrame, unpackStreamFrame } = require('../src/stream-frame');

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      let value = data;
      if (!isBinary) {
        try { value = JSON.parse(data.toString()); } catch {}
      }
      if (!predicate(value, isBinary)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ value, isBinary });
    };
    ws.on('message', onMessage);
  });
}

test('relay negotiates permessage-deflate and preserves large compressed payload integrity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-deflate-test-'));
  const { config } = loadRelayConfig({ env: { RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  const relay = new RelayServer(config, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const httpBase = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const hostAuth = { 'X-Herdr-Host-Id': 'host-1', 'X-Herdr-Host-Token': 'host-token-123456789' };
  const host = await openWebSocket(`${wsBase}/ws/host`);
  t.after(() => host.close());

  const hostReadyPromise = nextMessage(host, (m) => m.type === 'host_ready');
  host.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'host-1',
    token: 'host-token-123456789',
    hostname: 'test-host',
    platform: 'linux',
    arch: 'x64',
  }));
  await hostReadyPromise;

  const pairRes = await fetch(`${httpBase}/api/pair/start`, { method: 'POST', headers: hostAuth });
  const { code: pairCode } = await pairRes.json();

  let clientUpgradeHeader = null;
  const client = new WebSocket(`${wsBase}/ws/client`);
  client.on('upgrade', (res) => {
    clientUpgradeHeader = res.headers['sec-websocket-extensions'];
  });
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  t.after(() => client.close());

  // 1. Assert permessage-deflate negotiation:
  // - ws exposes negotiated extension name via `ws.extensions` getter (Object.keys(this._extensions).join())
  // - ws internal extensions registry `ws._extensions['permessage-deflate']` contains the active PerMessageDeflate instance
  // - HTTP upgrade handshake includes `sec-websocket-extensions: permessage-deflate`
  assert.equal(client.extensions, 'permessage-deflate');
  assert.match(clientUpgradeHeader || '', /permessage-deflate/);
  assert.ok(client._extensions && client._extensions['permessage-deflate'], 'permessage-deflate extension should be active on client socket');

  // Also assert on the host socket
  assert.equal(host.extensions, 'permessage-deflate');
  assert.ok(host._extensions && host._extensions['permessage-deflate'], 'permessage-deflate extension should be active on host socket');

  // Pair client to establish session stream
  const clientReadyPromise = nextMessage(client, (m) => m.type === 'ready');
  const sessionStartPromise = nextMessage(host, (m) => m.type === 'session_start');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode, clientId: 'client-1', cols: 80, rows: 24 }));

  const sessionStartMsg = (await sessionStartPromise).value;
  await clientReadyPromise;
  const streamId = sessionStartMsg.streamId;

  // Acknowledge session start from host
  host.send(JSON.stringify({ type: 'session_ready', clientId: streamId }));

  // 2. Assert large repetitive payload (> 1024 bytes) transmission and data integrity
  // Create repetitive ANSI escape sequence content (2960 bytes, well above the 1024-byte compression threshold)
  const repetitiveText = '\x1b[38;2;255;100;50mHighly repetitive ANSI redraw line buffer test data\x1b[0m\n'.repeat(40);
  const largePayload = Buffer.from(repetitiveText, 'utf8');
  assert.ok(largePayload.length > 1024, `Payload size (${largePayload.length}) must exceed 1024 bytes`);

  // Host -> Relay -> Client (output frame)
  const clientOutputPromise = nextMessage(client, (_msg, isBinary) => isBinary);
  host.send(packStreamFrame('output', streamId, largePayload));

  const receivedFrame = (await clientOutputPromise).value;
  assert.equal(Buffer.isBuffer(receivedFrame) || receivedFrame instanceof Uint8Array, true);
  assert.equal(receivedFrame.length, largePayload.length);
  assert.deepEqual(Buffer.from(receivedFrame), largePayload);

  // Client -> Relay -> Host (input frame)
  const hostInputPromise = nextMessage(host, (_msg, isBinary) => isBinary);
  client.send(largePayload);

  const hostRawFrame = (await hostInputPromise).value;
  const unpackedInput = unpackStreamFrame(hostRawFrame);
  assert.equal(unpackedInput.type, 'input');
  assert.equal(unpackedInput.streamId, streamId);
  assert.deepEqual(unpackedInput.payload, largePayload);
});
