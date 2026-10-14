import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeOpenLinkUrl } from '../src/protocol/terminal';
import { RelayServer } from '../src/relay-server';
import { nextMessage, openWebSocket, postJson, relayConfig } from './helpers.js';

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-test', 'X-Herdr-Host-Token': 'host-token-secret' };

async function startRelay(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-open-link-'));
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
  const links = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === 'open_link') links.push(msg.url);
  });
  return { ws, streamId, links };
}

test('a link the host opens reaches only the window whose stream clicked it', async (t) => {
  const relay = await startRelay(t);
  const hostWs = await openWebSocket(`${relay.wsBase}/ws/host`);
  t.onTestFinished(() => hostWs.close());
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(
    JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-test',
      token: HOST_AUTH['X-Herdr-Host-Token'],
    }),
  );
  // The host only diverts links once it knows this relay will deliver them.
  assert.deepEqual((await hostReady).value.capabilities, ['open_link']);

  const a = await openWindow(relay, hostWs, 'browser-a');
  const b = await openWindow(relay, hostWs, 'browser-b');
  t.onTestFinished(() => {
    a.ws.close();
    b.ws.close();
  });

  const delivered = nextMessage(a.ws, (msg) => msg.type === 'open_link');
  hostWs.send(
    JSON.stringify({
      type: 'open_link',
      clientId: a.streamId,
      url: 'javascript:alert(1)',
    }),
  );
  hostWs.send(
    JSON.stringify({
      type: 'open_link',
      clientId: a.streamId,
      url: 'https://example.com/issues/1',
    }),
  );
  assert.equal((await delivered).value.url, 'https://example.com/issues/1');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(a.links, ['https://example.com/issues/1']);
  assert.deepEqual(b.links, []);
});

test('only http and https links of a sane length are ever opened', () => {
  assert.equal(sanitizeOpenLinkUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c');
  assert.equal(sanitizeOpenLinkUrl('http://localhost:3000/'), 'http://localhost:3000/');
  assert.equal(sanitizeOpenLinkUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeOpenLinkUrl('file:///etc/passwd'), null);
  assert.equal(sanitizeOpenLinkUrl('vscode://file/x'), null);
  assert.equal(sanitizeOpenLinkUrl('not a url'), null);
  assert.equal(sanitizeOpenLinkUrl(42), null);
  assert.equal(sanitizeOpenLinkUrl(`https://example.com/${'a'.repeat(9_000)}`), null);
});
