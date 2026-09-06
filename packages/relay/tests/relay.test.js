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
    version: '0.2.0',
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
  assert.equal(sessionMessage.clientId, readyMessage.clientId);
  assert.equal(typeof pairedMessage.token, 'string');

  const sessionReady = nextMessage(client, (message) => message.type === 'session_ready');
  host.send(JSON.stringify({
    type: 'session_ready',
    clientId: sessionMessage.clientId,
  }));
  assert.equal((await sessionReady).value.clientId, readyMessage.clientId);

  const output = Buffer.from('\x1b[31mherdr\x1b[0m\r\n', 'utf8');
  const outputMessage = nextMessage(client, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', sessionMessage.clientId, output));
  assert.deepEqual((await outputMessage).value, output);

  const input = Buffer.from('\x03', 'binary');
  const inputMessage = nextMessage(host, (message, isBinary) => {
    if (!isBinary) return false;
    const frame = unpackStreamFrame(message);
    return frame.type === 'input';
  });
  client.send(input);
  const inputFrame = unpackStreamFrame((await inputMessage).value);
  assert.equal(inputFrame.streamId, sessionMessage.clientId);
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

test('relay makes a second authenticated client read-only and supports takeover', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-control-'));
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
  await firstSession;
  const tokenMessage = (await firstPair).value;
  const second = await openWebSocket(`${wsBase}/ws/client`);
  const secondReady = nextMessage(second, (message) => message.type === 'ready');
  const secondSession = nextMessage(host, (message) => message.type === 'session_start');
  second.send(JSON.stringify({ type: 'hello', protocol: 1, token: tokenMessage.token, clientId: 'second', cols: 80, rows: 24 }));
  assert.equal((await secondReady).value.role, 'viewer');
  await secondSession;
  const denied = nextMessage(second, (message) => message.type === 'control_denied');
  second.send(JSON.stringify({ type: 'claim_control' }));
  assert.equal((await denied).value.type, 'control_denied');
  const granted = nextMessage(second, (message) => message.type === 'control_granted');
  second.send(JSON.stringify({ type: 'claim_control', force: true }));
  assert.equal((await granted).value.type, 'control_granted');
  const currentController = [...relay.clients.values()].find((client) => client.role === 'controller');
  assert.ok(currentController);
  assert.notEqual(currentController.id, firstReadyValue.clientId);
  assert.equal(firstReadyValue.role, 'controller');
  first.close();
  second.close();
  host.close();
});

test('a viewer may size its own pty stream without holding the control lease', async (t) => {
  // Each client gets its own PTY, so geometry is per-stream and the control
  // lease has nothing to say about it. When this was gated on the lease, a
  // second client stayed at the 80x24 it opened with and the agent painted
  // into a grid the terminal did not have: blank rows below the output and
  // columns clipped off the right edge.
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
  const controller = await openWebSocket(`${wsBase}/ws/client`);
  const controllerPair = nextMessage(controller, (message) => message.type === 'paired');
  const controllerReady = nextMessage(controller, (message) => message.type === 'ready');
  controller.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'first', cols: 80, rows: 24 }));
  assert.equal((await controllerReady).value.role, 'controller');
  const token = (await controllerPair).value.token;

  const viewer = await openWebSocket(`${wsBase}/ws/client`);
  const viewerReady = nextMessage(viewer, (message) => message.type === 'ready');
  const viewerSession = nextMessage(host, (message) => message.type === 'session_start');
  // The phone's real grid, announced up front so the PTY opens at the right
  // size even before any resize is sent.
  viewer.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'phone', cols: 49, rows: 46 }));
  const viewerId = (await viewerReady).value.clientId;
  const viewerSessionMessage = (await viewerSession).value;
  assert.equal(viewerSessionMessage.role, 'viewer');
  assert.equal(viewerSessionMessage.cols, 49);
  assert.equal(viewerSessionMessage.rows, 46);

  // ...and a later refinement is forwarded to the host for that stream only.
  const hostResize = nextMessage(host, (message) => message.type === 'resize');
  viewer.send(JSON.stringify({ type: 'resize', cols: 50, rows: 47 }));
  const resizeMessage = (await hostResize).value;
  assert.equal(resizeMessage.clientId, viewerId);
  assert.equal(resizeMessage.cols, 50);
  assert.equal(resizeMessage.rows, 47);
  assert.equal(relay.clients.get(viewerId).role, 'viewer');

  // Typing stays lease-gated: a keystroke reaches the shared agent.
  const denied = nextMessage(viewer, (message) => message.type === 'control_denied');
  viewer.send(Buffer.from('\x03', 'binary'));
  assert.match((await denied).value.message, /read-only/i);

  controller.close();
  viewer.close();
  host.close();
});

test('a viewer may scroll its own pty stream but may not type into it', async (t) => {
  // Scrolling is per-stream for the same reason geometry is: the viewer has
  // its own PTY, so a wheel report only moves its own screen. A full-screen
  // agent owns its history and leaves xterm no scrollback, so without this a
  // viewer could not read back through the output at all.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-scroll-'));
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
  const controller = await openWebSocket(`${wsBase}/ws/client`);
  const controllerPair = nextMessage(controller, (message) => message.type === 'paired');
  const controllerReady = nextMessage(controller, (message) => message.type === 'ready');
  controller.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'first', cols: 80, rows: 24 }));
  assert.equal((await controllerReady).value.role, 'controller');
  const token = (await controllerPair).value.token;

  const viewer = await openWebSocket(`${wsBase}/ws/client`);
  const viewerReady = nextMessage(viewer, (message) => message.type === 'ready');
  viewer.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'phone', cols: 80, rows: 24 }));
  const viewerId = (await viewerReady).value.clientId;
  assert.equal(relay.clients.get(viewerId).role, 'viewer');

  const nextInputFrame = () =>
    nextMessage(host, (message, isBinary) => isBinary && unpackStreamFrame(message).type === 'input');

  // An SGR wheel-down report reaches the viewer's own stream untouched.
  const wheel = Buffer.from('\x1b[<65;12;5M', 'binary');
  const wheelArrival = nextInputFrame();
  viewer.send(wheel);
  const wheelFrame = unpackStreamFrame((await wheelArrival).value);
  assert.equal(wheelFrame.streamId, viewerId);
  assert.deepEqual(wheelFrame.payload, wheel);

  // So does the single-byte encoding, which is sent as raw bytes.
  const x10Wheel = Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0x30, 0x30]);
  const x10Arrival = nextInputFrame();
  viewer.send(x10Wheel);
  assert.deepEqual(unpackStreamFrame((await x10Arrival).value).payload, x10Wheel);

  // Everything that is not a wheel is still refused, including a click at the
  // same coordinates and an arrow key, which a TUI forwards to the agent.
  for (const refused of ['\x1b[<0;12;5M', '\x1b[A', 'ls\r', '\x1b[<65;12;5M\x03']) {
    const denied = nextMessage(viewer, (message) => message.type === 'control_denied');
    viewer.send(Buffer.from(refused, 'binary'));
    assert.match((await denied).value.message, /read-only/i, `expected refusal for ${JSON.stringify(refused)}`);
  }

  // The controller is unaffected: it may still type.
  const controllerInput = nextInputFrame();
  controller.send(Buffer.from('\x03', 'binary'));
  assert.deepEqual(unpackStreamFrame((await controllerInput).value).payload, Buffer.from('\x03', 'binary'));

  controller.close();
  viewer.close();
  host.close();
});
