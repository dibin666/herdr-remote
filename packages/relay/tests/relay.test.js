'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { RelayServer } = require('../src/relay-server');
const { packStreamFrame, unpackStreamFrame } = require('../src/stream-frame');
const { loadRelayConfig } = require('../src/relay-config');

// Headers proving we are the workstation that owns `host-1`.
const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-1', 'X-Herdr-Host-Token': 'host-token-123456789' };

function config() {
  return {
    relay: {
      local: true,
      url: 'ws://127.0.0.1:0',
      publicUrl: 'http://127.0.0.1:0',
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes: 1024 * 1024,
      maxClientsPerHost: 8,
      maxHosts: 8,
      maxBufferedBytesPerClient: 1024,
      hostReconnectGraceMs: 500,
    },
    auth: { pairingTtlMs: 60_000, deviceTtlMs: 60_000, maxDevices: 8 },
    cleanup: { intervalMs: 60_000, heartbeatIntervalMs: 60_000, staleAfterMs: 180_000 },
  };
}

function nextMessage(ws, predicate = () => true, timeoutMs = 1500) {
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

test('relay admin token can be configured from environment, file options, or CLI', () => {
  assert.equal(loadRelayConfig({ env: { RELAY_ADMIN_TOKEN: 'env-admin-token' } }).config.auth.adminToken, 'env-admin-token');
  assert.equal(loadRelayConfig({ argv: ['--admin-token', 'cli-admin-token'], env: {} }).config.auth.adminToken, 'cli-admin-token');
  assert.equal(loadRelayConfig({ env: { RELAY_DEPLOYMENT_MODE: 'local' } }).config.relay.mode, 'local');
  assert.equal(loadRelayConfig({ argv: ['--deployment-mode', 'local'], env: {} }).config.relay.mode, 'local');
  assert.equal(loadRelayConfig({ env: {
    RELAY_MAX_HOSTS: '12',
    RELAY_MAX_PENDING_HANDSHAKES: '34',
    RELAY_MAX_BUFFERED_BYTES_PER_CLIENT: '65536',
    RELAY_HOST_RECONNECT_GRACE_MS: '5000',
  } }).config.relay.maxHosts, 12);
  const tuned = loadRelayConfig({ env: {
    RELAY_MAX_PENDING_HANDSHAKES: '34',
    RELAY_MAX_BUFFERED_BYTES_PER_CLIENT: '65536',
    RELAY_HOST_RECONNECT_GRACE_MS: '5000',
  } }).config.relay;
  assert.equal(tuned.maxPendingHandshakes, 34);
  assert.equal(tuned.maxBufferedBytesPerClient, 65536);
  assert.equal(tuned.hostReconnectGraceMs, 5000);
});

test('relay info identifies local and operator-facing deployments without credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-info-'));
  const relayConfig = config();
  relayConfig.relay.mode = 'local';
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const response = await fetch(`${base}/api/info`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    // Read from the manifest so a release does not have to touch this test.
    version: require('../package.json').version,
    protocol: 1,
    relayMode: 'local',
    isRemoteRelay: false,
    adminConfigured: false,
    adminPath: '/admin',
    adminStatusPath: '/api/admin/status',
    publicUrl: 'http://127.0.0.1:0',
    remoteAdminUrl: null,
  });
});

test('scoped status and public health never expose another host', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-scope-'));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const hostA = await openWebSocket(`${wsBase}/ws/host`);
  const hostB = await openWebSocket(`${wsBase}/ws/host`);
  hostA.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-a', token: 'host-a-token-123456789' }));
  hostB.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-b', token: 'host-b-token-123456789' }));
  await Promise.all([
    nextMessage(hostA, (message) => message.type === 'host_ready'),
    nextMessage(hostB, (message) => message.type === 'host_ready'),
  ]);

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(Object.hasOwn(health, 'hosts'), false);
  assert.equal(Object.hasOwn(health, 'clients'), false);

  const statusA = await (await fetch(`${base}/api/status`, { headers: {
    'X-Herdr-Host-Id': 'host-a',
    'X-Herdr-Host-Token': 'host-a-token-123456789',
  } })).json();
  const statusB = await (await fetch(`${base}/api/status`, { headers: {
    'X-Herdr-Host-Id': 'host-b',
    'X-Herdr-Host-Token': 'host-b-token-123456789',
  } })).json();
  assert.deepEqual(statusA.hosts.map((host) => host.id), ['host-a']);
  assert.deepEqual(statusB.hosts.map((host) => host.id), ['host-b']);
  assert.equal(statusA.hosts.some((host) => host.id === 'host-b'), false);
  assert.equal(Object.hasOwn(statusA.clients[0] || {}, 'hostId'), false);

  // Device credentials are tenant scoped in exactly the same way as host
  // credentials; a browser paired to A must never receive B's host record.
  const pairingA = await postJson(`${base}/api/pair/start`, {
    'X-Herdr-Host-Id': 'host-a',
    'X-Herdr-Host-Token': 'host-a-token-123456789',
  });
  const pairingB = await postJson(`${base}/api/pair/start`, {
    'X-Herdr-Host-Id': 'host-b',
    'X-Herdr-Host-Token': 'host-b-token-123456789',
  });
  const clientA = await openWebSocket(`${wsBase}/ws/client`);
  const clientB = await openWebSocket(`${wsBase}/ws/client`);
  const pairedA = nextMessage(clientA, (message) => message.type === 'paired');
  const pairedB = nextMessage(clientB, (message) => message.type === 'paired');
  const readyA = nextMessage(clientA, (message) => message.type === 'ready');
  const readyB = nextMessage(clientB, (message) => message.type === 'ready');
  clientA.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingA.code, clientId: 'device-a', cols: 80, rows: 24 }));
  clientB.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingB.code, clientId: 'device-b', cols: 80, rows: 24 }));
  const [pairedAMessage, pairedBMessage] = await Promise.all([pairedA, pairedB]);
  await Promise.all([readyA, readyB]);
  const tokenA = pairedAMessage.value.token;
  const tokenB = pairedBMessage.value.token;
  const deviceStatusA = await (await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  })).json();
  const deviceStatusB = await (await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })).json();
  assert.deepEqual(deviceStatusA.hosts.map((host) => host.id), ['host-a']);
  assert.deepEqual(deviceStatusB.hosts.map((host) => host.id), ['host-b']);
  assert.equal(deviceStatusA.hosts.some((host) => host.id === 'host-b'), false);

  const mixed = await fetch(`${base}/api/status`, { headers: {
    'X-Herdr-Host-Id': 'host-a',
    'X-Herdr-Host-Token': 'host-a-token-123456789',
    Authorization: 'Bearer no-device-token-for-host-b',
  } });
  assert.equal(mixed.status, 401);
  clientA.close();
  clientB.close();
  hostA.close();
  hostB.close();
});

test('CORS echoes only an explicitly allowed origin', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-cors-'));
  const relayConfig = config();
  relayConfig.relay.allowedOrigins = ['https://console.example'];
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const allowed = await fetch(`${base}/api/info`, { headers: { Origin: 'https://console.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://console.example');
  const denied = await fetch(`${base}/api/info`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
});

test('relay pairs a client and preserves output/input streams', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-'));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789', hostname: 'test-host', platform: 'linux', arch: 'x64' }));
  assert.equal((await nextMessage(host, (message) => message.type === 'host_ready')).value.hostId, 'host-1');
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: HOST_AUTH })).status, 200);

  // A pairing code can only be minted by whoever holds that workstation's own
  // host token, which is what keeps a shared relay safe.
  assert.equal((await fetch(`${base}/api/pair/start`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/pair/start`, {
    method: 'POST',
    headers: { 'X-Herdr-Host-Id': 'host-1', 'X-Herdr-Host-Token': 'wrong-token-000000000' },
  })).status, 401);

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  assert.match(pairing.pairUrl, /pairCode=/);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const clientReady = nextMessage(client, (message) => message.type === 'ready');
  const paired = nextMessage(client, (message) => message.type === 'paired');
  const sessionStart = nextMessage(host, (message) => message.type === 'session_start');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'phone-1', cols: 80, rows: 24 }));
  const pairedMessage = (await paired).value;
  const readyMessage = (await clientReady).value;
  const sessionMessage = (await sessionStart).value;
  assert.equal(readyMessage.role, 'controller');
  assert.equal(typeof readyMessage.clientId, 'string');
  // The stream belongs to the workstation's shared terminal, not to whichever
  // browser happened to open it first.
  assert.equal(typeof sessionMessage.streamId, 'string');
  assert.notEqual(sessionMessage.streamId, readyMessage.clientId);
  assert.equal(typeof pairedMessage.token, 'string');
  const streamId = sessionMessage.streamId;

  const sessionReady = nextMessage(client, (message) => message.type === 'session_ready');
  host.send(JSON.stringify({
    type: 'session_ready',
    clientId: streamId,
  }));
  assert.equal((await sessionReady).value.clientId, readyMessage.clientId);

  const output = Buffer.from('\x1b[31mherdr\x1b[0m\r\n', 'utf8');
  const outputMessage = nextMessage(client, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', streamId, output));
  assert.deepEqual((await outputMessage).value, output);

  const input = Buffer.from('\x03', 'binary');
  const inputMessage = nextMessage(host, (message, isBinary) => {
    if (!isBinary) return false;
    const frame = unpackStreamFrame(message);
    return frame.type === 'input';
  });
  client.send(input);
  const inputFrame = unpackStreamFrame((await inputMessage).value);
  assert.equal(inputFrame.streamId, streamId);
  assert.deepEqual(inputFrame.payload, input);

  client.close();
  host.close();
});

test('relay operator dashboard requires its separate admin token', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-admin-'));
  const relayConfig = config();
  relayConfig.auth.adminToken = 'operator-secret-123456789';
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/status`, {
    headers: { 'X-Relay-Admin-Token': 'wrong-token' },
  })).status, 401);
  const response = await fetch(`${base}/api/admin/status`, {
    headers: { 'X-Relay-Admin-Token': 'operator-secret-123456789' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.relay.dashboardPath, '/admin');
  assert.equal(body.relay.port, address.port);
  assert.ok(Object.hasOwn(body, 'clients'));
});

test('relay operator dashboard reports when administration is not configured', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-admin-disabled-'));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const response = await fetch(`${base}/api/admin/status`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'admin_not_configured');
});

test('workstation status remains scoped away from the operator token', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-admin-status-'));
  const relayConfig = config();
  relayConfig.auth.adminToken = 'operator-secret-123456789';
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const response = await fetch(`${base}/api/status`, {
    headers: { 'X-Relay-Admin-Token': 'operator-secret-123456789' },
  });
  assert.equal(response.status, 401);
});

// Every window paired to a workstation gets its own terminal: a dedicated
// PTY stream and its own geometry, without being constrained by other windows.
test('every paired window gets its own terminal and all of them may type', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-dedicated-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());
  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');
  const pairing1 = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const first = await openWebSocket(`${wsBase}/ws/client`);
  const firstPair = nextMessage(first, (message) => message.type === 'paired');
  const firstReady = nextMessage(first, (message) => message.type === 'ready');
  const firstSession = nextMessage(host, (message) => message.type === 'session_start');
  first.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing1.code, clientId: 'first', cols: 80, rows: 24 }));
  const firstReadyValue = (await firstReady).value;
  const firstStreamId = (await firstSession).value.streamId;
  const tokenMessage = (await firstPair).value;

  const second = await openWebSocket(`${wsBase}/ws/client`);
  const secondReady = nextMessage(second, (message) => message.type === 'ready');
  const secondSession = nextMessage(host, (message) => message.type === 'session_start');
  second.send(JSON.stringify({ type: 'hello', protocol: 1, token: tokenMessage.token, clientId: 'second', cols: 80, rows: 24 }));
  const secondReadyValue = (await secondReady).value;
  const secondStreamId = (await secondSession).value.streamId;

  assert.equal(firstReadyValue.role, 'controller');
  assert.equal(secondReadyValue.role, 'controller');
  assert.notEqual(firstStreamId, secondStreamId);

  // Output written to stream A reaches only window A, never window B.
  const outputA = Buffer.from('output-for-first\r\n', 'utf8');
  let secondReceivedOutput = false;
  const onSecondMessage = (data, isBinary) => {
    if (isBinary && Buffer.compare(data, outputA) === 0) secondReceivedOutput = true;
  };
  second.on('message', onSecondMessage);

  const onFirst = nextMessage(first, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', firstStreamId, outputA));
  assert.deepEqual((await onFirst).value, outputA);

  await new Promise((resolve) => setTimeout(resolve, 50));
  second.off('message', onSecondMessage);
  assert.equal(secondReceivedOutput, false, 'second window must not receive output meant for first window');

  // Both windows type into their own terminals, stamped with their own stream ids.
  const nextInputFrame = () =>
    nextMessage(host, (message, isBinary) => isBinary && unpackStreamFrame(message).type === 'input');

  const arrival1 = nextInputFrame();
  first.send(Buffer.from('a', 'binary'));
  const frame1 = unpackStreamFrame((await arrival1).value);
  assert.equal(frame1.streamId, firstStreamId);
  assert.deepEqual(frame1.payload, Buffer.from('a', 'binary'));

  const arrival2 = nextInputFrame();
  second.send(Buffer.from('b', 'binary'));
  const frame2 = unpackStreamFrame((await arrival2).value);
  assert.equal(frame2.streamId, secondStreamId);
  assert.deepEqual(frame2.payload, Buffer.from('b', 'binary'));

  first.close();
  second.close();
  host.close();
});

test('each window drives its own grid without shrinking the others', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-resize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const laptop = await openWebSocket(`${wsBase}/ws/client`);
  const laptopPair = nextMessage(laptop, (message) => message.type === 'paired');
  const laptopReady = nextMessage(laptop, (message) => message.type === 'ready');
  const laptopSession = nextMessage(host, (message) => message.type === 'session_start');
  laptop.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'laptop', cols: 80, rows: 24 }));
  await laptopReady;
  const laptopStreamId = (await laptopSession).value.streamId;
  const token = (await laptopPair).value.token;

  const phone = await openWebSocket(`${wsBase}/ws/client`);
  const phoneReady = nextMessage(phone, (message) => message.type === 'ready');
  const phoneSession = nextMessage(host, (message) => message.type === 'session_start');
  phone.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'phone', cols: 80, rows: 24 }));
  await phoneReady;
  const phoneStreamId = (await phoneSession).value.streamId;

  const resizes = [];
  const onHostMessage = (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize') resizes.push(msg);
      } catch {}
    }
  };
  host.on('message', onHostMessage);

  const laptopResized = nextMessage(host, (msg) => msg.type === 'resize' && msg.streamId === laptopStreamId);
  laptop.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  const laptopMsg = (await laptopResized).value;
  assert.equal(laptopMsg.streamId, laptopStreamId);
  assert.equal(laptopMsg.cols, 120);
  assert.equal(laptopMsg.rows, 40);

  const phoneResized = nextMessage(host, (msg) => msg.type === 'resize' && msg.streamId === phoneStreamId);
  phone.send(JSON.stringify({ type: 'resize', cols: 40, rows: 20 }));
  const phoneMsg = (await phoneResized).value;
  assert.equal(phoneMsg.streamId, phoneStreamId);
  assert.equal(phoneMsg.cols, 40);
  assert.equal(phoneMsg.rows, 20);

  await new Promise((resolve) => setTimeout(resolve, 50));
  host.off('message', onHostMessage);
  const laptopResizes = resizes.filter((r) => r.streamId === laptopStreamId);
  assert.equal(laptopResizes.length, 1);
  assert.equal(laptopResizes[0].cols, 120);
  assert.equal(laptopResizes[0].rows, 40);

  laptop.close();
  phone.close();
  host.close();
});

test('a window opening a session gets its own stream id and geometry', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-session-grid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const sessionStart = nextMessage(host, (message) => message.type === 'session_start');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'only', cols: 100, rows: 30 }));
  const started = (await sessionStart).value;
  assert.ok(typeof started.streamId === 'string' && started.streamId.startsWith('session-'));
  assert.equal(started.cols, 100);
  assert.equal(started.rows, 30);

  client.close();
  host.close();
});

test('a window joining late starts its own session instead of replaying another window', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const first = await openWebSocket(`${wsBase}/ws/client`);
  const firstPair = nextMessage(first, (message) => message.type === 'paired');
  const firstReady = nextMessage(first, (message) => message.type === 'ready');
  const sessionStartA = nextMessage(host, (message) => message.type === 'session_start');
  first.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'first', cols: 80, rows: 24 }));
  await firstReady;
  const streamIdA = (await sessionStartA).value.streamId;
  const token = (await firstPair).value.token;

  host.send(JSON.stringify({ type: 'session_ready', clientId: streamIdA }));
  const printed = Buffer.from('already on screen for A\r\n', 'utf8');
  const seenByFirst = nextMessage(first, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', streamIdA, printed));
  assert.deepEqual((await seenByFirst).value, printed);

  const late = await openWebSocket(`${wsBase}/ws/client`);
  let lateGotOutput = false;
  const onLateMessage = (data, isBinary) => {
    if (isBinary && Buffer.compare(data, printed) === 0) lateGotOutput = true;
  };
  late.on('message', onLateMessage);

  const sessionStartB = nextMessage(host, (message) => message.type === 'session_start');
  const lateReady = nextMessage(late, (message) => message.type === 'ready');
  late.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'late', cols: 80, rows: 24 }));
  await lateReady;
  const streamIdB = (await sessionStartB).value.streamId;

  assert.notEqual(streamIdB, streamIdA);
  await new Promise((resolve) => setTimeout(resolve, 50));
  late.off('message', onLateMessage);
  assert.equal(lateGotOutput, false, 'late window must not replay output from another session');

  first.close();
  late.close();
  host.close();
});

test('input from one window never reaches another window stream', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-stream-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const first = await openWebSocket(`${wsBase}/ws/client`);
  const firstPair = nextMessage(first, (message) => message.type === 'paired');
  const firstReady = nextMessage(first, (message) => message.type === 'ready');
  const sessionStart1 = nextMessage(host, (message) => message.type === 'session_start');
  first.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'first', cols: 80, rows: 24 }));
  await firstReady;
  const streamId1 = (await sessionStart1).value.streamId;
  const token = (await firstPair).value.token;

  const second = await openWebSocket(`${wsBase}/ws/client`);
  const secondReady = nextMessage(second, (message) => message.type === 'ready');
  const sessionStart2 = nextMessage(host, (message) => message.type === 'session_start');
  second.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'second', cols: 80, rows: 24 }));
  await secondReady;
  const streamId2 = (await sessionStart2).value.streamId;
  assert.notEqual(streamId1, streamId2);

  const nextInputFrame = () =>
    nextMessage(host, (message, isBinary) => isBinary && unpackStreamFrame(message).type === 'input');

  const arrival1 = nextInputFrame();
  first.send(Buffer.from('keystroke-1', 'utf8'));
  const frame1 = unpackStreamFrame((await arrival1).value);
  assert.equal(frame1.streamId, streamId1);
  assert.deepEqual(frame1.payload, Buffer.from('keystroke-1', 'utf8'));

  const arrival2 = nextInputFrame();
  second.send(Buffer.from('keystroke-2', 'utf8'));
  const frame2 = unpackStreamFrame((await arrival2).value);
  assert.equal(frame2.streamId, streamId2);
  assert.deepEqual(frame2.payload, Buffer.from('keystroke-2', 'utf8'));

  const arrival3 = nextInputFrame();
  first.send(Buffer.from('keystroke-3', 'utf8'));
  const frame3 = unpackStreamFrame((await arrival3).value);
  assert.equal(frame3.streamId, streamId1);
  assert.deepEqual(frame3.payload, Buffer.from('keystroke-3', 'utf8'));

  first.close();
  second.close();
  host.close();
});

test('a session is never started below the minimum usable grid', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-min-grid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const sessionStart = nextMessage(host, (message) => message.type === 'session_start');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'tiny', cols: 5, rows: 3 }));
  const started = (await sessionStart).value;
  assert.equal(started.cols, 20);
  assert.equal(started.rows, 6);

  client.close();
  host.close();
});

test('the workstation palette reaches the browser with ready, before any output', async (t) => {
  // A browser cannot know what the session looks like on the workstation, so
  // the host reports its own terminal colors and the relay hands them over in
  // the first message a client gets — before the first PTY byte, or the
  // terminal would repaint mid-session.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-palette-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const ansi = {
    black: '#2e3436',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec',
  };

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'host-1',
    token: 'host-token-123456789',
    terminalPalette: {
      background: '#222226',
      foreground: '#ffffff',
      cursor: '#ffffff',
      // A hostile or buggy workstation cannot smuggle anything else through.
      injected: 'url(javascript:alert(1))',
      ansi,
    },
  }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const ready = nextMessage(client, (message) => message.type === 'ready');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'phone', cols: 80, rows: 24 }));

  const palette = (await ready).value.terminalPalette;
  assert.equal(palette.background, '#222226');
  assert.equal(palette.foreground, '#ffffff');
  assert.equal(palette.cursor, '#ffffff');
  assert.deepEqual(palette.ansi, ansi);
  assert.equal(palette.injected, undefined);

  client.close();
  host.close();
});

test('a host with no terminal to ask leaves the browser on its own defaults', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-no-palette-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'host-1',
    token: 'host-token-123456789',
    terminalPalette: null,
  }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const ready = nextMessage(client, (message) => message.type === 'ready');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'phone', cols: 80, rows: 24 }));

  assert.equal((await ready).value.terminalPalette, null);

  client.close();
  host.close();
});

// Two tabs of one browser share a client id, because that id is persisted per
// browser profile. The relay used to close whichever session already held it,
// so the two tabs evicted each other in a loop that never converged: each
// eviction triggered the other tab's auto-reconnect, which evicted this one
// back, forever. Both are now simply attached to the same shared terminal.
test('two windows of one browser both stay attached instead of evicting each other', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-resume-'));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const firstTab = await openWebSocket(`${wsBase}/ws/client`);
  const firstPaired = nextMessage(firstTab, (message) => message.type === 'paired');
  const firstReady = nextMessage(firstTab, (message) => message.type === 'ready');
  firstTab.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-a', cols: 80, rows: 24 }));
  assert.equal((await firstReady).value.role, 'controller');
  const { token } = (await firstPaired).value;

  // A second tab of the same browser, announcing the same persisted client id.
  const secondTab = await openWebSocket(`${wsBase}/ws/client`);
  const secondReady = nextMessage(secondTab, (message) => message.type === 'ready');
  const firstTabClosed = new Promise((resolve) => firstTab.once('close', resolve));
  secondTab.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'browser-a', cols: 80, rows: 24 }));
  assert.equal((await secondReady).value.role, 'controller');

  // The first tab is untouched: nothing closed it, so nothing makes it
  // reconnect and start the eviction loop over again.
  const closedEarly = await Promise.race([
    firstTabClosed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(closedEarly, false, 'an open tab must not be evicted by another tab');
  assert.equal(relay.clients.size, 2);
  assert.equal(relay.hosts.get('host-1').clients.size, 2);

  // A genuinely different browser sharing the same device token joins the same
  // terminal on the same terms.
  const other = await openWebSocket(`${wsBase}/ws/client`);
  const otherReady = nextMessage(other, (message) => message.type === 'ready');
  other.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'browser-b', cols: 80, rows: 24 }));
  assert.equal((await otherReady).value.role, 'controller');
  assert.equal(relay.clients.size, 3);
});

test('a capable host reconnects without dropping its authorized browser', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-handoff-'));
  const relayConfig = config();
  relayConfig.relay.hostReconnectGraceMs = 500;
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());
  const hello = { type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789', capabilities: ['host_handoff', 'idle_heartbeat'] };

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify(hello));
  await nextMessage(host, (message) => message.type === 'host_ready');
  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const paired = nextMessage(client, (message) => message.type === 'paired');
  const ready = nextMessage(client, (message) => message.type === 'ready');
  const firstSession = nextMessage(host, (message) => message.type === 'session_start');
  client.send(JSON.stringify({
    type: 'hello',
    protocol: 1,
    pairCode: pairing.code,
    clientId: 'browser-a',
    cols: 80,
    rows: 24,
    capabilities: ['host_handoff'],
  }));
  await ready;
  await paired;
  await firstSession;

  const reconnecting = nextMessage(client, (message) => message.type === 'host_reconnecting');
  host.close();
  await reconnecting;
  assert.equal(relay.clients.size, 1, 'the authorized browser remains attached during handoff');

  const replacement = await openWebSocket(`${wsBase}/ws/host`);
  const replacementReady = nextMessage(replacement, (message) => message.type === 'host_ready');
  const replacementSession = nextMessage(replacement, (message) => message.type === 'session_start');
  const restarted = nextMessage(client, (message) => message.type === 'session_restarted');
  replacement.send(JSON.stringify(hello));
  await replacementReady;
  const session = (await replacementSession).value;
  const reset = (await restarted).value;
  assert.equal(typeof session.streamId, 'string');
  assert.equal(reset.streamId, session.streamId);
  assert.notEqual(relay.hosts.get('host-1').ws, host);
  assert.equal(relay.hosts.get('host-1').ws.readyState, WebSocket.OPEN);
  assert.equal(relay.clients.size, 1);

  client.close();
  replacement.close();
});

test('an operator can list paired devices and revoke one', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-revoke-'));
  const relayConfig = config();
  relayConfig.auth.adminToken = 'operator-secret-123456789';
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const admin = { 'X-Relay-Admin-Token': 'operator-secret-123456789' };
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-1', token: 'host-token-123456789' }));
  await nextMessage(host, (message) => message.type === 'host_ready');

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const paired = nextMessage(client, (message) => message.type === 'paired');
  const ready = nextMessage(client, (message) => message.type === 'ready');
  client.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'browser-a', cols: 80, rows: 24 }));
  await ready;
  const { deviceId, token } = (await paired).value;

  // The roster is operator-only: a paired device may read /api/status, and that
  // response must not enumerate everyone else's hardware.
  const deviceStatus = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(deviceStatus.status, 200);
  assert.equal(Object.hasOwn(await deviceStatus.json(), 'devices'), false);

  const listed = await (await fetch(`${base}/api/admin/status`, { headers: admin })).json();
  const entry = listed.devices.find((device) => device.deviceId === deviceId);
  assert.ok(entry, 'the paired device should appear in the operator roster');
  assert.equal(Object.hasOwn(entry, 'tokenHash'), false, 'token hashes must never leave the process');

  const closed = new Promise((resolve) => client.once('close', resolve));
  const revoked = await fetch(`${base}/api/admin/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', headers: admin });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).disconnected, 1);

  // Revocation is immediate, not deferred to the next reconnect.
  await closed;
  assert.equal(relay.clients.size, 0);

  // And the token it was derived from is dead.
  const rejected = await openWebSocket(`${wsBase}/ws/client`);
  const refusal = nextMessage(rejected, (message) => message.type === 'error');
  rejected.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'browser-a', cols: 80, rows: 24 }));
  assert.equal((await refusal).value.code, 'auth_required');

  assert.equal((await fetch(`${base}/api/admin/devices/device-nope`, { method: 'DELETE', headers: admin })).status, 404);
});

test('the status board counts devices and their hosts, not open sockets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-board-'));
  const relayConfig = config();
  relayConfig.auth.adminToken = 'operator-secret-123456789';
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const admin = { 'X-Relay-Admin-Token': 'operator-secret-123456789' };
  const hostAAuth = { 'X-Herdr-Host-Id': 'host-a', 'X-Herdr-Host-Token': 'host-a-token-123456789' };
  const hostBAuth = { 'X-Herdr-Host-Id': 'host-b', 'X-Herdr-Host-Token': 'host-b-token-123456789' };
  t.after(async () => relay.close());

  const hostA = await openWebSocket(`${wsBase}/ws/host`);
  const hostB = await openWebSocket(`${wsBase}/ws/host`);
  hostA.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-a', token: 'host-a-token-123456789' }));
  hostB.send(JSON.stringify({ type: 'host_hello', protocol: 1, hostId: 'host-b', token: 'host-b-token-123456789' }));
  await Promise.all([
    nextMessage(hostA, (message) => message.type === 'host_ready'),
    nextMessage(hostB, (message) => message.type === 'host_ready'),
  ]);

  // One device on host-a, with two windows of the same browser open...
  const pairingA = await postJson(`${base}/api/pair/start`, hostAAuth);
  const windowOne = await openWebSocket(`${wsBase}/ws/client`);
  const pairedOne = nextMessage(windowOne, (message) => message.type === 'paired');
  const readyOne = nextMessage(windowOne, (message) => message.type === 'ready');
  windowOne.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingA.code, clientId: 'browser-a', cols: 80, rows: 24 }));
  await readyOne;
  const deviceToken = (await pairedOne).value.token;

  const windowTwo = await openWebSocket(`${wsBase}/ws/client`);
  const readyTwo = nextMessage(windowTwo, (message) => message.type === 'ready');
  windowTwo.send(JSON.stringify({ type: 'hello', protocol: 1, token: deviceToken, clientId: 'browser-a', cols: 80, rows: 24 }));
  await readyTwo;

  // ...and a second, separate device on host-b.
  const pairingB = await postJson(`${base}/api/pair/start`, hostBAuth);
  const otherDevice = await openWebSocket(`${wsBase}/ws/client`);
  const readyOther = nextMessage(otherDevice, (message) => message.type === 'ready');
  otherDevice.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairingB.code, clientId: 'browser-b', cols: 80, rows: 24 }));
  await readyOther;

  const board = await (await fetch(`${base}/api/admin/status`, { headers: admin })).json();
  // Three sockets, two people: the second window is the same person as the first.
  assert.equal(board.clientCount, 3);
  assert.equal(board.activeUserCount, 2);

  const hostRow = (id) => board.hosts.find((host) => host.id === id);
  assert.equal(hostRow('host-a').connectedDeviceCount, 1);
  assert.equal(hostRow('host-a').pairedDeviceCount, 1);
  assert.equal(hostRow('host-b').connectedDeviceCount, 1);
  assert.equal(hostRow('host-b').pairedDeviceCount, 1);

  // The counts are public; the roster they are derived from is not.
  const scoped = await (await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })).json();
  assert.equal(Object.hasOwn(scoped, 'devices'), false);
  assert.equal(Object.hasOwn(scoped.clients[0] || {}, 'deviceId'), false);
  assert.deepEqual(scoped.hosts.map((host) => host.id), ['host-a']);
  assert.equal(scoped.hosts[0].pairedDeviceCount, 1);
  // Two windows of one browser stay one user even on the scoped response,
  // where the rows themselves no longer say which device they belong to.
  assert.equal(scoped.clients.length, 2);
  assert.equal(scoped.activeUserCount, 1);

  windowOne.close();
  windowTwo.close();
  otherDevice.close();
  hostA.close();
  hostB.close();
});

test('idle heartbeat refreshes host lastSeenAt on relay', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-idle-heartbeat-'));
  const relayConfig = config();
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const host = await openWebSocket(`${wsBase}/ws/host`);
  host.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'host-idle-test',
    token: 'host-token-123456789',
    capabilities: ['host_handoff', 'idle_heartbeat'],
  }));
  await nextMessage(host, (m) => m.type === 'host_ready');

  const hostRecord = relay.hosts.get('host-idle-test');
  assert.ok(hostRecord);

  // Artificially age the host lastSeenAt
  hostRecord.lastSeenAt = Date.now() - 10_000;
  const oldLastSeen = hostRecord.lastSeenAt;

  // Send idle heartbeat
  host.send(JSON.stringify({
    type: 'heartbeat',
    load: {},
    ptys: [],
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(hostRecord.lastSeenAt > oldLastSeen, 'host lastSeenAt should be refreshed by idle heartbeat');
  host.close();
});

test('inactive or stuck CLOSING sockets are terminated by heartbeat and sweep', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-terminate-'));
  const relayConfig = config();
  relayConfig.cleanup.staleAfterMs = 500;
  const relay = new RelayServer(relayConfig, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.after(async () => relay.close());

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  hostWs.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'host-term-test',
    token: 'host-token-123456789',
    capabilities: ['host_handoff', 'idle_heartbeat'],
  }));
  await nextMessage(hostWs, (m) => m.type === 'host_ready');

  const hostRecord = relay.hosts.get('host-term-test');
  assert.ok(hostRecord);
  const serverWs = hostRecord.ws;

  // 1. Inactive socket in heartbeat: when isAlive is false, heartbeat terminates socket
  let terminated = false;
  const originalTerminate = serverWs.terminate;
  serverWs.terminate = function (...args) {
    terminated = true;
    return originalTerminate.apply(this, args);
  };
  serverWs.isAlive = false;

  relay.heartbeat();
  assert.ok(terminated, 'heartbeat() should terminate inactive socket instead of only closing it');

  // 2. CLOSING socket in heartbeat: terminated immediately
  let closingTerminated = false;
  const mockClosingSocket = {
    readyState: WebSocket.CLOSING,
    isAlive: true,
    terminate() { closingTerminated = true; },
  };
  relay.hosts.set('mock-closing', { id: 'mock-closing', ws: mockClosingSocket, clients: new Set() });
  relay.heartbeat();
  assert.ok(closingTerminated, 'heartbeat() should terminate socket stuck in CLOSING');
  relay.hosts.delete('mock-closing');

  // 3. Stale host in sweep: terminates socket
  let staleTerminated = false;
  const mockStaleSocket = {
    readyState: WebSocket.OPEN,
    isAlive: true,
    terminate() { staleTerminated = true; },
    close() {},
  };
  relay.hosts.set('mock-stale', {
    id: 'mock-stale',
    ws: mockStaleSocket,
    clients: new Set(),
    reconnecting: false,
    lastSeenAt: Date.now() - 10_000,
  });
  relay.sweep();
  assert.ok(staleTerminated, 'sweep() should terminate stale host socket');
  assert.equal(relay.hosts.has('mock-stale'), false, 'stale host should be detached');

  hostWs.close();
});
