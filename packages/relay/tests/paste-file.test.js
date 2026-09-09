'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { RelayServer } = require('../src/relay-server');

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-test', 'X-Herdr-Host-Token': 'host-token-secret' };

function relayConfig() {
  return {
    relay: {
      local: true,
      url: 'ws://127.0.0.1:0',
      publicUrl: 'http://127.0.0.1:0',
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes: 5 * 1024 * 1024,
      maxClientsPerHost: 8,
      maxHosts: 8,
      maxBufferedBytesPerClient: 1024,
      hostReconnectGraceMs: 500,
    },
    auth: { pairingTtlMs: 60_000, deviceTtlMs: 60_000, maxDevices: 8 },
    cleanup: { intervalMs: 60_000, heartbeatIntervalMs: 60_000, staleAfterMs: 180_000 },
  };
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

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function postJson(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(urlString, { method: 'POST', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { return reject(error); }
        if (response.statusCode >= 400) return reject(new Error(body.message || `HTTP ${response.statusCode}`));
        resolve(body);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('paste_file rejects unsupported MIME type with paste_file_unsupported error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'] }));
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientWs = await openWebSocket(`${wsBase}/ws/client`);

  const clientReady = nextMessage(clientWs, (msg) => msg.type === 'ready');
  clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-test', cols: 80, rows: 24 }));
  await clientReady;

  // Send paste_file with unsupported MIME
  const errorMsg = nextMessage(clientWs, (msg) => msg.type === 'error');
  clientWs.send(JSON.stringify({
    type: 'paste_file',
    mime: 'application/pdf',
    dataBase64: Buffer.from('dummy-pdf').toString('base64'),
  }));

  const res = await errorMsg;
  assert.equal(res.value.code, 'paste_file_unsupported');

  clientWs.close();
  hostWs.close();
});

test('paste_file rejects payload over 3 MB with paste_file_too_large and keeps connection alive', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'] }));
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientWs = await openWebSocket(`${wsBase}/ws/client`);

  const clientReady = nextMessage(clientWs, (msg) => msg.type === 'ready');
  clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-test', cols: 80, rows: 24 }));
  await clientReady;

  // 3.5 MB buffer (exceeds 3 MB limit)
  const oversizedBuf = Buffer.alloc(3.5 * 1024 * 1024, 0x41);
  const dataBase64 = oversizedBuf.toString('base64');

  const errorMsg = nextMessage(clientWs, (msg) => msg.type === 'error');
  clientWs.send(JSON.stringify({
    type: 'paste_file',
    mime: 'image/png',
    dataBase64,
  }));

  const res = await errorMsg;
  assert.equal(res.value.code, 'paste_file_too_large');

  // Assert WebSocket connection is STILL ALIVE
  assert.equal(clientWs.readyState, WebSocket.OPEN);

  // Assert we can still exchange ping / pong normally
  const pongMsg = nextMessage(clientWs, (msg) => msg.type === 'pong');
  clientWs.send(JSON.stringify({ type: 'ping' }));
  await pongMsg;

  clientWs.close();
  hostWs.close();
});

test('paste_file forwards valid request with streamId to host, and routes paste_file_ready exclusively to that client', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'] }));
  await hostReady;

  // Connect Client A
  const pairingA = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientA = await openWebSocket(`${wsBase}/ws/client`);
  const readyA = nextMessage(clientA, (msg) => msg.type === 'ready');
  clientA.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingA.code, clientId: 'browser-a', cols: 80, rows: 24 }));
  await readyA;

  // Connect Client B
  const pairingB = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientB = await openWebSocket(`${wsBase}/ws/client`);
  const readyB = nextMessage(clientB, (msg) => msg.type === 'ready');
  clientB.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingB.code, clientId: 'browser-b', cols: 80, rows: 24 }));
  await readyB;

  // Client A sends paste_file
  const hostReceivedPaste = nextMessage(hostWs, (msg) => msg.type === 'paste_file');
  const validPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  clientA.send(JSON.stringify({
    type: 'paste_file',
    mime: 'image/png',
    dataBase64: validPayload,
  }));

  const hostMsg = (await hostReceivedPaste).value;
  assert.equal(hostMsg.type, 'paste_file');
  assert.equal(hostMsg.mime, 'image/png');
  assert.equal(hostMsg.dataBase64, validPayload);
  assert.ok(hostMsg.streamId, 'must carry streamId');

  // Host answers with paste_file_ready targeting Client A's streamId
  let clientBReceivedReady = false;
  clientB.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'paste_file_ready') clientBReceivedReady = true;
    } catch {}
  });

  const clientAReceivedReady = nextMessage(clientA, (msg) => msg.type === 'paste_file_ready');
  hostWs.send(JSON.stringify({
    type: 'paste_file_ready',
    clientId: hostMsg.streamId,
    path: '/state/pasted/fake-uuid.png',
  }));

  const resA = (await clientAReceivedReady).value;
  assert.equal(resA.path, '/state/pasted/fake-uuid.png');

  // Ensure Client B did NOT receive the message
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(clientBReceivedReady, false);

  clientA.close();
  clientB.close();
  hostWs.close();
});

test('paste_file rejects mismatched magic bytes on relay with paste_file_unsupported error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'] }));
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientWs = await openWebSocket(`${wsBase}/ws/client`);
  const clientReady = nextMessage(clientWs, (msg) => msg.type === 'ready');
  clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-test', cols: 80, rows: 24 }));
  await clientReady;

  // Fake PNG with plain text bytes
  const fakePng = Buffer.from('NOT A REAL PNG FILE').toString('base64');
  const errorMsg = nextMessage(clientWs, (msg) => msg.type === 'error');
  clientWs.send(JSON.stringify({
    type: 'paste_file',
    mime: 'image/png',
    dataBase64: fakePng,
  }));

  const res = await errorMsg;
  assert.equal(res.value.code, 'paste_file_unsupported');
  assert.equal(clientWs.readyState, WebSocket.OPEN);

  clientWs.close();
  hostWs.close();
});

test('paste_file rejects request when host is offline with host_offline error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'], capabilities: ['host_handoff'] }));
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientWs = await openWebSocket(`${wsBase}/ws/client`);
  const clientReady = nextMessage(clientWs, (msg) => msg.type === 'ready');
  clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-test', cols: 80, rows: 24, capabilities: ['host_handoff'] }));
  await clientReady;

  // Close host socket to simulate host disconnect
  hostWs.close();
  await new Promise((r) => setTimeout(r, 50));

  const validPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const errorMsg = nextMessage(clientWs, (msg) => msg.type === 'error');
  clientWs.send(JSON.stringify({
    type: 'paste_file',
    mime: 'image/png',
    dataBase64: validPayload,
  }));

  const res = await errorMsg;
  assert.equal(res.value.code, 'host_offline');
  assert.equal(clientWs.readyState, WebSocket.OPEN);

  clientWs.close();
});

test('paste_file rejects request when client is viewer mode with viewer_mode error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-paste-test-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-test', token: HOST_AUTH['X-Herdr-Host-Token'] }));
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const clientWs = await openWebSocket(`${wsBase}/ws/client`);
  const clientReady = nextMessage(clientWs, (msg) => msg.type === 'ready');
  clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-test', cols: 80, rows: 24, mode: 'viewer' }));
  await clientReady;

  for (const c of server.clients.values()) c.role = 'viewer';

  const validPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const errorMsg = nextMessage(clientWs, (msg) => msg.type === 'error');
  clientWs.send(JSON.stringify({
    type: 'paste_file',
    mime: 'image/png',
    dataBase64: validPayload,
  }));

  const res = await errorMsg;
  assert.equal(res.value.code, 'viewer_mode');
  assert.equal(clientWs.readyState, WebSocket.OPEN);

  clientWs.close();
  hostWs.close();
});
