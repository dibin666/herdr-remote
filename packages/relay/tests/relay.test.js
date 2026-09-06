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

// Every window paired to a workstation is a view of the *same* terminal: one
// PTY, one screen, and no lease to pass around. A second window that opened its
// own shell would show a different screen from the first, which is exactly what
// somebody watching the same agent from a phone and a laptop does not want.
test('every paired window shares one terminal and all of them may type', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-shared-'));
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
  const streamId = (await firstSession).value.streamId;
  const tokenMessage = (await firstPair).value;

  const second = await openWebSocket(`${wsBase}/ws/client`);
  const secondReady = nextMessage(second, (message) => message.type === 'ready');
  second.send(JSON.stringify({ type: 'hello', protocol: 1, token: tokenMessage.token, clientId: 'second', cols: 80, rows: 24 }));
  const secondReadyValue = (await secondReady).value;

  // No second shell is started, and nobody is demoted.
  assert.equal(firstReadyValue.role, 'controller');
  assert.equal(secondReadyValue.role, 'controller');
  assert.equal(relay.hosts.get('host-1').session.streamId, streamId);
  assert.equal([...relay.clients.values()].every((client) => client.role === 'controller'), true);

  // One byte from the workstation lands on every screen.
  const output = Buffer.from('shared\r\n', 'utf8');
  const onFirst = nextMessage(first, (_message, isBinary) => isBinary);
  const onSecond = nextMessage(second, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', streamId, output));
  assert.deepEqual((await onFirst).value, output);
  assert.deepEqual((await onSecond).value, output);

  // And both windows type into it, on the one stream.
  const nextInputFrame = () =>
    nextMessage(host, (message, isBinary) => isBinary && unpackStreamFrame(message).type === 'input');
  for (const [socket, keystroke] of [[first, 'a'], [second, 'b']]) {
    const arrival = nextInputFrame();
    socket.send(Buffer.from(keystroke, 'binary'));
    const frame = unpackStreamFrame((await arrival).value);
    assert.equal(frame.streamId, streamId);
    assert.deepEqual(frame.payload, Buffer.from(keystroke, 'binary'));
  }

  // The old lease request is still answered, so an older client keeps working.
  const granted = nextMessage(second, (message) => message.type === 'control_granted');
  second.send(JSON.stringify({ type: 'claim_control' }));
  assert.equal((await granted).value.type, 'control_granted');

  // Closing one window leaves the terminal running for the other.
  const firstClosed = new Promise((resolve) => first.once('close', resolve));
  first.close();
  await firstClosed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(relay.hosts.get('host-1').session, 'the shared terminal outlives any one window');

  second.close();
  host.close();
});

// A shared terminal has one grid, and it has to be one every attached window
// can draw: the smallest. A column a phone cannot show is a column the program
// must not paint, or the laptop watching the same session sees wrapped rubbish.
test('the shared grid follows the smallest attached window', async (t) => {
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
  const sessionStart = nextMessage(host, (message) => message.type === 'session_start');
  laptop.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'laptop', cols: 120, rows: 40 }));
  await laptopReady;
  const started = (await sessionStart).value;
  const streamId = started.streamId;
  assert.equal(started.cols, 120);
  assert.equal(started.rows, 40);
  const token = (await laptopPair).value.token;

  // A phone joins: the session shrinks to what the phone can show, and the
  // resize doubles as the repaint that puts both windows on the same screen.
  const phoneJoined = nextMessage(host, (message) => message.type === 'resize');
  const phone = await openWebSocket(`${wsBase}/ws/client`);
  const phoneReady = nextMessage(phone, (message) => message.type === 'ready');
  phone.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'phone', cols: 49, rows: 46 }));
  await phoneReady;
  const shrunk = (await phoneJoined).value;
  assert.equal(shrunk.streamId, streamId);
  assert.equal(shrunk.cols, 49);
  assert.equal(shrunk.rows, 40);

  // Either window may resize; the smallest of the two still wins.
  const afterLaptop = nextMessage(host, (message) => message.type === 'resize');
  laptop.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  const narrowed = (await afterLaptop).value;
  assert.equal(narrowed.cols, 49);
  assert.equal(narrowed.rows, 30);

  // When the phone closes its window the grid grows back to the laptop's.
  const afterPhoneLeft = nextMessage(host, (message) => message.type === 'resize');
  phone.close();
  const restored = (await afterPhoneLeft).value;
  assert.equal(restored.cols, 100);
  assert.equal(restored.rows, 30);

  laptop.close();
  host.close();
});

// A window that joins a session already in progress has missed everything
// printed before it arrived. Replaying the tail of the stream is what makes
// "every window shows the same thing" true from its first painted frame.
test('a window joining late is caught up with what has already been printed', async (t) => {
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
  const sessionStart = nextMessage(host, (message) => message.type === 'session_start');
  first.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: pairing.code, clientId: 'first', cols: 80, rows: 24 }));
  await firstReady;
  const streamId = (await sessionStart).value.streamId;
  const token = (await firstPair).value.token;

  host.send(JSON.stringify({ type: 'session_ready', clientId: streamId }));
  const printed = Buffer.from('already on screen\r\n', 'utf8');
  const seenByFirst = nextMessage(first, (_message, isBinary) => isBinary);
  host.send(packStreamFrame('output', streamId, printed));
  await seenByFirst;

  const late = await openWebSocket(`${wsBase}/ws/client`);
  const replayed = nextMessage(late, (_message, isBinary) => isBinary);
  const lateSessionReady = nextMessage(late, (message) => message.type === 'session_ready');
  late.send(JSON.stringify({ type: 'hello', protocol: 1, token, clientId: 'late', cols: 80, rows: 24 }));
  assert.deepEqual((await replayed).value, printed);
  // It is told the terminal is live too, rather than waiting for a start it
  // will never see because the session was opened before it arrived.
  await lateSessionReady;

  first.close();
  late.close();
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
