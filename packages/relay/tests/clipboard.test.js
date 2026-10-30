import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../src/relay-server';
import { nextJson, nextMessage, openWebSocket, postJson, relayConfig } from './helpers.js';

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-test', 'X-Herdr-Host-Token': 'host-token-secret' };

async function startRelay(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-clipboard-'));
  const server = new RelayServer(relayConfig(), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    wsBase: `ws://127.0.0.1:${address.port}`,
  };
}

async function connectHost({ wsBase }) {
  const ws = await openWebSocket(`${wsBase}/ws/host`);
  ws.send(
    JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-test',
      token: HOST_AUTH['X-Herdr-Host-Token'],
    }),
  );
  await nextMessage(ws, (msg) => msg.type === 'host_ready');
  return ws;
}

/** A paired browser window, and the stream the host was told to start for it. */
async function openWindow({ base, wsBase }, hostWs, clientId) {
  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const ws = await openWebSocket(`${wsBase}/ws/client`);
  const sessionStart = nextMessage(hostWs, (msg) => msg.type === 'session_start');
  const ready = nextMessage(ws, (msg) => msg.type === 'ready');
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol: 1,
      pairCode: pairing.code,
      clientId,
      cols: 80,
      rows: 24,
    }),
  );
  await ready;
  const streamId = (await sessionStart).value.streamId;
  return { ws, streamId };
}

test('a clipboard write reaches only the window that owns the stream', async (t) => {
  const relay = await startRelay(t);
  const hostWs = await connectHost(relay);
  t.onTestFinished(() => hostWs.close());
  const a = await openWindow(relay, hostWs, 'browser-a');
  const b = await openWindow(relay, hostWs, 'browser-b');
  t.onTestFinished(() => {
    a.ws.close();
    b.ws.close();
  });

  const delivered = nextJson(a.ws, (msg) => msg.type === 'clipboard_write');
  hostWs.send(
    JSON.stringify({
      type: 'clipboard_write',
      clientId: a.streamId,
      text: 'copied in herdr',
    }),
  );
  assert.equal((await delivered).text, 'copied in herdr');

  // Not a string, or too long to be clipboard text: dropped before any window.
  hostWs.send(JSON.stringify({ type: 'clipboard_write', clientId: a.streamId, text: 42 }));
  hostWs.send(
    JSON.stringify({
      type: 'clipboard_write',
      clientId: a.streamId,
      text: 'x'.repeat(1_000_001),
    }),
  );
  // A write for a stream that is gone reaches nobody either.
  hostWs.send(
    JSON.stringify({
      type: 'clipboard_write',
      clientId: 'stream-gone',
      text: 'nobody',
    }),
  );
  await assert.rejects(
    nextJson(a.ws, (msg) => msg.type === 'clipboard_write', 150),
    /timed out/,
  );
  await assert.rejects(
    nextJson(b.ws, (msg) => msg.type === 'clipboard_write', 150),
    /timed out/,
  );
});

test('a clipboard read reaches its window and the answer comes back to the host', async (t) => {
  const relay = await startRelay(t);
  const hostWs = await connectHost(relay);
  t.onTestFinished(() => hostWs.close());
  const a = await openWindow(relay, hostWs, 'browser-a');
  const b = await openWindow(relay, hostWs, 'browser-b');
  t.onTestFinished(() => {
    a.ws.close();
    b.ws.close();
  });

  const read = nextJson(a.ws, (msg) => msg.type === 'clipboard_read');
  hostWs.send(JSON.stringify({ type: 'clipboard_read', clientId: a.streamId, requestId: 'req-1' }));
  assert.equal((await read).requestId, 'req-1');
  await assert.rejects(
    nextJson(b.ws, (msg) => msg.type === 'clipboard_read', 150),
    /timed out/,
  );

  const reply = nextJson(hostWs, (msg) => msg.type === 'clipboard_read_reply');
  a.ws.send(
    JSON.stringify({ type: 'clipboard_read_reply', requestId: 'req-1', text: 'local clipboard' }),
  );
  const value = await reply;
  assert.equal(value.requestId, 'req-1');
  assert.equal(value.text, 'local clipboard');
  assert.equal(value.clientId, a.streamId);
});

test('a malformed clipboard read reaches no window', async (t) => {
  const relay = await startRelay(t);
  const hostWs = await connectHost(relay);
  t.onTestFinished(() => hostWs.close());
  const a = await openWindow(relay, hostWs, 'browser-a');
  t.onTestFinished(() => a.ws.close());

  for (const requestId of ['', 42, 'x'.repeat(65), null]) {
    hostWs.send(JSON.stringify({ type: 'clipboard_read', clientId: a.streamId, requestId }));
  }
  await assert.rejects(
    nextJson(a.ws, (msg) => msg.type === 'clipboard_read', 150),
    /timed out/,
  );
});
