'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { RelayServer } = require('../src/relay-server');
const { loadRelayConfig } = require('../src/relay-config');
const {
  FRAME_V2_MAGIC,
  FRAME_TYPE_OUTPUT,
  FRAME_TYPE_INPUT,
  packStreamFrame,
  unpackStreamFrame,
  packStreamFrameV2,
  unpackStreamFrameV2,
} = require('../src/stream-frame');

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

test('v2 round-trip: packStreamFrameV2 and unpackStreamFrameV2 preserve payload byte-for-byte', () => {
  const testCases = [
    { type: FRAME_TYPE_OUTPUT, typeStr: 'output', index: 0, payload: Buffer.from('hello world', 'utf8') },
    { type: FRAME_TYPE_INPUT, typeStr: 'input', index: 1, payload: Buffer.from('\x1b[31mRed Alert\x1b[0m', 'utf8') },
    { type: FRAME_TYPE_OUTPUT, typeStr: 'output', index: 65535, payload: Buffer.from([0x00, 0xff, 0xfe, 0x42]) },
    { type: 'input', typeStr: 'input', index: 42, payload: Buffer.alloc(0) }, // empty payload
    { type: 'output', typeStr: 'output', index: 12345, payload: Buffer.from('large payload '.repeat(200), 'utf8') },
  ];

  for (const tc of testCases) {
    const packed = packStreamFrameV2(tc.type, tc.index, tc.payload);
    assert.equal(packed[0], FRAME_V2_MAGIC);
    assert.equal(packed.length, 4 + tc.payload.length);

    const unpacked = unpackStreamFrameV2(packed);
    assert.equal(unpacked.version, 2);
    assert.equal(unpacked.type, tc.typeStr);
    assert.equal(unpacked.streamIndex, tc.index);
    assert.deepEqual(unpacked.payload, tc.payload);
  }
});

test('unified unpackStreamFrame entry point accurately discriminates v1 and v2 frames', () => {
  const payload = Buffer.from('test-payload', 'utf8');

  // Format v1
  const frameV1 = packStreamFrame('output', 'stream-xyz', payload);
  assert.equal(frameV1[0], 0x00); // 4-byte uint32BE length <= 8KB always starts with 0x00
  const unpackedV1 = unpackStreamFrame(frameV1);
  assert.equal(unpackedV1.version, 1);
  assert.equal(unpackedV1.type, 'output');
  assert.equal(unpackedV1.streamId, 'stream-xyz');
  assert.equal(unpackedV1.streamIndex, undefined);
  assert.deepEqual(unpackedV1.payload, payload);

  // Format v2
  const frameV2 = packStreamFrameV2(FRAME_TYPE_INPUT, 999, payload);
  assert.equal(frameV2[0], FRAME_V2_MAGIC); // Always 0xFF
  const unpackedV2 = unpackStreamFrame(frameV2);
  assert.equal(unpackedV2.version, 2);
  assert.equal(unpackedV2.type, 'input');
  assert.equal(unpackedV2.typeCode, FRAME_TYPE_INPUT);
  assert.equal(unpackedV2.streamIndex, 999);
  assert.equal(unpackedV2.streamId, undefined);
  assert.deepEqual(unpackedV2.payload, payload);
});

test('malformed v2 frames are safely rejected without throwing unhandled exceptions', () => {
  // Truncated frames (< 4 bytes)
  assert.throws(() => unpackStreamFrameV2(Buffer.from([0xff])), /truncated/);
  assert.throws(() => unpackStreamFrameV2(Buffer.from([0xff, 0x00])), /truncated/);
  assert.throws(() => unpackStreamFrameV2(Buffer.from([0xff, 0x00, 0x01])), /truncated/);
  assert.throws(() => unpackStreamFrame(Buffer.from([0xff, 0x00])), /truncated/);

  // Invalid magic byte
  assert.throws(() => unpackStreamFrameV2(Buffer.from([0xfe, 0x00, 0x00, 0x01])), /magic byte/);

  // Unknown frame type
  assert.throws(() => unpackStreamFrameV2(Buffer.from([0xff, 0x05, 0x00, 0x01])), /unknown v2 stream frame type/);

  // packStreamFrameV2 validation: invalid type or out-of-range streamIndex
  assert.throws(() => packStreamFrameV2('invalid-type', 1), /FRAME_TYPE_OUTPUT/);
  assert.throws(() => packStreamFrameV2(99, 1), /FRAME_TYPE_OUTPUT/);
  assert.throws(() => packStreamFrameV2(0, -1), /unsigned 16-bit integer/);
  assert.throws(() => packStreamFrameV2(0, 65536), /unsigned 16-bit integer/);
  assert.throws(() => packStreamFrameV2(0, 1.5), /unsigned 16-bit integer/);
});

test('streamIndex allocation: unique sequence, wraps cleanly, and recycles on session exit', () => {
  const { config } = loadRelayConfig({ env: { RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  const relay = new RelayServer(config);
  const host = { streamIndices: new Map(), nextStreamIndex: 0 };

  // 1. Unique consecutive allocation
  const idx0 = relay.allocateStreamIndex(host);
  host.streamIndices.set(idx0, 'client-0');
  const idx1 = relay.allocateStreamIndex(host);
  host.streamIndices.set(idx1, 'client-1');
  const idx2 = relay.allocateStreamIndex(host);
  host.streamIndices.set(idx2, 'client-2');

  assert.equal(idx0, 0);
  assert.equal(idx1, 1);
  assert.equal(idx2, 2);

  // 2. Recycle freed index
  host.streamIndices.delete(idx1); // client-1 disconnects
  // Advance to near wrap around
  host.nextStreamIndex = 65535;
  const idxWrap1 = relay.allocateStreamIndex(host);
  host.streamIndices.set(idxWrap1, 'client-wrap');
  assert.equal(idxWrap1, 65535);

  // After 65535, wraps to 0; 0 is taken (client-0), so it probes 1 (freed client-1)
  const idxWrap2 = relay.allocateStreamIndex(host);
  assert.equal(idxWrap2, 1);
});

test('negotiation: host with binary_frame_v2 receives v2 frames; host without capability receives v1 frames', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-v2-test-'));
  const { config } = loadRelayConfig({ env: { RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  const relay = new RelayServer(config, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const httpBase = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // --- Sub-test 1: V2-capable Host ---
  {
    const hostV2Auth = { 'X-Herdr-Host-Id': 'host-v2', 'X-Herdr-Host-Token': 'v2-token-123456789' };
    const hostV2Ws = await openWebSocket(`${wsBase}/ws/host`);
    t.after(() => hostV2Ws.close());

    const hostReadyPromise = nextMessage(hostV2Ws, (m) => m.type === 'host_ready');
    hostV2Ws.send(JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-v2',
      token: 'v2-token-123456789',
      capabilities: ['host_handoff', 'binary_frame_v2'],
    }));
    await hostReadyPromise;

    // Start pairing client
    const pairRes = await fetch(`${httpBase}/api/pair/start`, { method: 'POST', headers: hostV2Auth });
    const { code: pairCode } = await pairRes.json();

    const clientWs = await openWebSocket(`${wsBase}/ws/client`);
    t.after(() => clientWs.close());

    const sessionStartPromise = nextMessage(hostV2Ws, (m) => m.type === 'session_start');
    const clientReadyPromise = nextMessage(clientWs, (m) => m.type === 'ready');
    clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode, clientId: 'client-v2', cols: 80, rows: 24 }));

    const sessionStartMsg = (await sessionStartPromise).value;
    await clientReadyPromise;

    // session_start must contain numeric streamIndex
    assert.equal(typeof sessionStartMsg.streamIndex, 'number');
    const streamIndex = sessionStartMsg.streamIndex;

    // Client sends raw terminal input -> relay forwards as v2 frame to host
    const hostBinaryPromise = nextMessage(hostV2Ws, (_m, isBinary) => isBinary);
    const clientInput = Buffer.from('ls -la\r', 'utf8');
    clientWs.send(clientInput);

    const hostReceived = await hostBinaryPromise;
    assert.equal(hostReceived.isBinary, true);
    assert.equal(hostReceived.value[0], FRAME_V2_MAGIC, 'relay must send v2 frame (magic 0xFF) to v2-capable host');

    const unpackedHostFrame = unpackStreamFrame(hostReceived.value);
    assert.equal(unpackedHostFrame.version, 2);
    assert.equal(unpackedHostFrame.type, 'input');
    assert.equal(unpackedHostFrame.streamIndex, streamIndex);
    assert.deepEqual(unpackedHostFrame.payload, clientInput);

    // Host sends v2 output -> client receives raw payload without routing header
    const clientBinaryPromise = nextMessage(clientWs, (_m, isBinary) => isBinary);
    const hostOutput = Buffer.from('\x1b[32moutput line\x1b[0m\r\n', 'utf8');
    hostV2Ws.send(packStreamFrameV2(FRAME_TYPE_OUTPUT, streamIndex, hostOutput));

    const clientReceived = await clientBinaryPromise;
    assert.deepEqual(clientReceived.value, hostOutput);
  }

  // --- Sub-test 2: Legacy Host (no binary_frame_v2 capability) ---
  {
    const hostLegacyAuth = { 'X-Herdr-Host-Id': 'host-legacy', 'X-Herdr-Host-Token': 'legacy-token-123456789' };
    const hostLegacyWs = await openWebSocket(`${wsBase}/ws/host`);
    t.after(() => hostLegacyWs.close());

    const hostReadyPromise = nextMessage(hostLegacyWs, (m) => m.type === 'host_ready');
    hostLegacyWs.send(JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-legacy',
      token: 'legacy-token-123456789',
      capabilities: ['host_handoff'], // No binary_frame_v2!
    }));
    await hostReadyPromise;

    // Start pairing client
    const pairRes = await fetch(`${httpBase}/api/pair/start`, { method: 'POST', headers: hostLegacyAuth });
    const { code: pairCode } = await pairRes.json();

    const clientWs = await openWebSocket(`${wsBase}/ws/client`);
    t.after(() => clientWs.close());

    const sessionStartPromise = nextMessage(hostLegacyWs, (m) => m.type === 'session_start');
    const clientReadyPromise = nextMessage(clientWs, (m) => m.type === 'ready');
    clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode, clientId: 'client-legacy', cols: 80, rows: 24 }));

    const sessionStartMsg = (await sessionStartPromise).value;
    await clientReadyPromise;

    // session_start must NOT contain streamIndex for legacy host
    assert.equal(sessionStartMsg.streamIndex, undefined);
    const streamId = sessionStartMsg.streamId;
    assert.equal(typeof streamId, 'string');

    // Client sends raw terminal input -> relay forwards as v1 frame to legacy host
    const hostBinaryPromise = nextMessage(hostLegacyWs, (_m, isBinary) => isBinary);
    const clientInput = Buffer.from('whoami\r', 'utf8');
    clientWs.send(clientInput);

    const hostReceived = await hostBinaryPromise;
    assert.equal(hostReceived.isBinary, true);
    assert.equal(hostReceived.value[0], 0x00, 'relay must send v1 frame (first byte 0x00) to legacy host');

    const unpackedHostFrame = unpackStreamFrame(hostReceived.value);
    assert.equal(unpackedHostFrame.version, 1);
    assert.equal(unpackedHostFrame.type, 'input');
    assert.equal(unpackedHostFrame.streamId, streamId);
    assert.deepEqual(unpackedHostFrame.payload, clientInput);

    // Legacy host sends v1 output -> client receives raw payload without routing header
    const clientBinaryPromise = nextMessage(clientWs, (_m, isBinary) => isBinary);
    const hostOutput = Buffer.from('root\r\n', 'utf8');
    hostLegacyWs.send(packStreamFrame('output', streamId, hostOutput));

    const clientReceived = await clientBinaryPromise;
    assert.deepEqual(clientReceived.value, hostOutput);
  }
});

test("Postel's law: relay accepts v1 frames from v2 hosts, and ignores unrouted v2 frames from legacy hosts without closing connection", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-postel-test-'));
  const { config } = loadRelayConfig({ env: { RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  const relay = new RelayServer(config, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const httpBase = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // Case 1: Host declared binary_frame_v2 sends v1 frame (e.g. index exhaustion fallback)
  // Relay must route via streamId and NOT drop the host connection.
  {
    const hostAuth = { 'X-Herdr-Host-Id': 'host-v2-fallback', 'X-Herdr-Host-Token': 'v2-token-123456789' };
    const hostWs = await openWebSocket(`${wsBase}/ws/host`);
    t.after(() => hostWs.close());

    const hostReadyPromise = nextMessage(hostWs, (m) => m.type === 'host_ready');
    hostWs.send(JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-v2-fallback',
      token: 'v2-token-123456789',
      capabilities: ['host_handoff', 'binary_frame_v2'],
    }));
    await hostReadyPromise;

    const pairRes = await fetch(`${httpBase}/api/pair/start`, { method: 'POST', headers: hostAuth });
    const { code: pairCode } = await pairRes.json();
    const clientWs = await openWebSocket(`${wsBase}/ws/client`);
    t.after(() => clientWs.close());

    const sessionStartPromise = nextMessage(hostWs, (m) => m.type === 'session_start');
    const clientReadyPromise = nextMessage(clientWs, (m) => m.type === 'ready');
    clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode, clientId: 'client-fallback', cols: 80, rows: 24 }));
    const sessionStartMsg = (await sessionStartPromise).value;
    await clientReadyPromise;

    const streamId = sessionStartMsg.streamId;
    assert.equal(typeof streamId, 'string');
    assert.equal(typeof sessionStartMsg.streamIndex, 'number');

    // Send v1 output frame from this v2-capable host
    const clientBinaryPromise = nextMessage(clientWs, (_m, isBinary) => isBinary);
    const fallbackOutput = Buffer.from('fallback output from v2 host in v1 frame\r\n', 'utf8');
    hostWs.send(packStreamFrame('output', streamId, fallbackOutput));

    const clientReceived = await clientBinaryPromise;
    assert.deepEqual(clientReceived.value, fallbackOutput);
    assert.equal(hostWs.readyState, WebSocket.OPEN, 'host socket must remain open');
  }

  // Case 2: Legacy host (no binary_frame_v2) sends a v2 frame -> relay safely ignores/drops it without severing connection
  {
    const hostAuth = { 'X-Herdr-Host-Id': 'host-legacy-v2send', 'X-Herdr-Host-Token': 'legacy-token-123456789' };
    const hostWs = await openWebSocket(`${wsBase}/ws/host`);
    t.after(() => hostWs.close());

    const hostReadyPromise = nextMessage(hostWs, (m) => m.type === 'host_ready');
    hostWs.send(JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-legacy-v2send',
      token: 'legacy-token-123456789',
      capabilities: ['host_handoff'],
    }));
    await hostReadyPromise;

    const pairRes = await fetch(`${httpBase}/api/pair/start`, { method: 'POST', headers: hostAuth });
    const { code: pairCode } = await pairRes.json();
    const clientWs = await openWebSocket(`${wsBase}/ws/client`);
    t.after(() => clientWs.close());

    const sessionStartPromise = nextMessage(hostWs, (m) => m.type === 'session_start');
    const clientReadyPromise = nextMessage(clientWs, (m) => m.type === 'ready');
    clientWs.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode, clientId: 'client-leg-send', cols: 80, rows: 24 }));
    const sessionStartMsg = (await sessionStartPromise).value;
    await clientReadyPromise;
    const streamId = sessionStartMsg.streamId;

    // Legacy host sends an unrouted v2 frame -> relay drops it without disconnecting
    hostWs.send(packStreamFrameV2(FRAME_TYPE_OUTPUT, 99, Buffer.from('unrouted v2 from legacy host')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hostWs.readyState, WebSocket.OPEN, 'legacy host must NOT be disconnected for sending v2 frame');

    // Follow up with a valid v1 frame to prove host connection is fully intact
    const clientBinaryPromise = nextMessage(clientWs, (_m, isBinary) => isBinary);
    const normalOutput = Buffer.from('normal legacy v1 payload\r\n', 'utf8');
    hostWs.send(packStreamFrame('output', streamId, normalOutput));
    const clientReceived = await clientBinaryPromise;
    assert.deepEqual(clientReceived.value, normalOutput);
  }
});

test('relay safely disconnects host on truly malformed truncated binary frames without server crash', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-malformed-test-'));
  const { config } = loadRelayConfig({ env: { RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  const relay = new RelayServer(config, { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  const wsBase = `ws://127.0.0.1:${address.port}`;

  t.after(async () => {
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const readyPromise = nextMessage(hostWs, (m) => m.type === 'host_ready');
  hostWs.send(JSON.stringify({
    type: 'host_hello',
    protocol: 1,
    hostId: 'v2-host-malformed',
    token: 'v2-token-123456789',
    capabilities: ['binary_frame_v2'],
  }));
  await readyPromise;

  const closePromise = new Promise((resolve) => hostWs.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  // Send truncated frame with v2 magic byte (only 2 bytes) - unpacking throws Error
  hostWs.send(Buffer.from([0xff, 0x00]));
  const { code } = await closePromise;
  assert.equal(code, 1003);

  // Give relay server tick to process close and detach host
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Verify server is still alive and handling requests
  assert.equal(relay.hosts.size, 0);
});
