// The workstation's terminal font crosses the relay twice: as a family name
// that lands in a browser's CSS `font-family` list, and as file slices a
// browser asks for by hash. Both are untrusted here.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { RelayServer } from '../src/relay-server';
import { sanitizeTerminalFont, TERMINAL_FONT_CHUNK_BYTES } from '../src/protocol';

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-1', 'X-Herdr-Host-Token': 'host-token-123456789' };
const REGULAR = 'a'.repeat(64);
const BOLD = 'b'.repeat(64);
const CJK = 'c'.repeat(64);

const FONT = {
  family: 'JetBrainsMono Nerd Font',
  sizePx: 12,
  source: 'gnome-terminal',
  faces: [
    {
      style: 'regular',
      format: 'truetype',
      bytes: TERMINAL_FONT_CHUNK_BYTES * 2 + 10,
      sha256: REGULAR,
    },
    { style: 'bold', format: 'truetype', bytes: 100, sha256: BOLD },
  ],
  subsets: [{ family: 'Noto Sans CJK SC', style: 'regular', scope: 'cjk', sha256: CJK }],
};

test('a reported terminal font passes through, file paths and extras dropped', () => {
  const font = sanitizeTerminalFont({
    ...FONT,
    faces: [{ ...FONT.faces[0], path: '/home/you/.local/share/fonts/x.ttf' }],
    extra: 'dropped',
  });
  assert.deepEqual(font, { ...FONT, faces: [FONT.faces[0]] });

  // A subset source may not smuggle a family name or an unknown scope past it.
  assert.deepEqual(
    sanitizeTerminalFont({
      ...FONT,
      subsets: [
        { family: 'x"; }', style: 'regular', scope: 'cjk', sha256: CJK },
        { family: 'Noto Sans CJK SC', style: 'bold', scope: 'cjk', sha256: CJK },
        { family: 'Noto Sans CJK SC', style: 'regular', scope: 'emoji', sha256: CJK },
        {
          family: 'Noto Sans CJK SC',
          style: 'regular',
          scope: 'cjk',
          sha256: CJK,
          path: '/secret',
        },
      ],
    }).subsets,
    FONT.subsets,
  );
});

test('a family that could break out of a CSS font-family list is refused', () => {
  for (const family of [
    'a", serif; } body { x: "',
    "Evil'Font",
    'A,B',
    'A;B',
    'A\\B',
    'line\nbreak',
    '',
    'x'.repeat(129),
  ]) {
    assert.equal(sanitizeTerminalFont({ family }), null, family);
  }
  assert.equal(sanitizeTerminalFont(null), null);
  assert.equal(sanitizeTerminalFont('JetBrains Mono'), null);
});

test('malformed faces, sizes and sources are dropped one by one', () => {
  const font = sanitizeTerminalFont({
    family: 'Fira Code',
    sizePx: 'huge',
    source: 'GNOME Terminal!',
    faces: [
      { style: 'regular', format: 'truetype', bytes: 10, sha256: 'not-a-hash' },
      { style: 'regular', format: 'woff2', bytes: 10, sha256: REGULAR },
      { style: 'heavy', format: 'truetype', bytes: 10, sha256: REGULAR },
      { style: 'bold', format: 'opentype', bytes: 64 * 1024 * 1024, sha256: BOLD },
      { style: 'italic', format: 'opentype', bytes: 10, sha256: BOLD },
      { style: 'italic', format: 'opentype', bytes: 10, sha256: REGULAR },
    ],
  });
  assert.deepEqual(font, {
    family: 'Fira Code',
    faces: [{ style: 'italic', format: 'opentype', bytes: 10, sha256: BOLD }],
    subsets: [],
  });
});

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
      maxBufferedBytesPerClient: 1024 * 1024,
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
      if (isBinary) return;
      let value;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(value)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(value);
    };
    ws.on('message', onMessage);
  });
}

function collect(ws) {
  const seen = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      seen.push(JSON.parse(data.toString()));
    } catch {}
  });
  return seen;
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
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function startStack(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-font-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = new RelayServer(config(), { stateFile: path.join(directory, 'auth.json') });
  const address = await relay.listen(0, '127.0.0.1');
  t.onTestFinished(async () => relay.close());
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const host = await openWebSocket(`${wsBase}/ws/host`);
  const toHost = collect(host);
  host.send(
    JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-1',
      token: 'host-token-123456789',
      terminalFont: FONT,
    }),
  );
  await nextMessage(host, (message) => message.type === 'host_ready');

  const open = async (clientId) => {
    const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
    const client = await openWebSocket(`${wsBase}/ws/client`);
    const ready = nextMessage(client, (message) => message.type === 'ready');
    const started = nextMessage(host, (message) => message.type === 'session_start');
    client.send(
      JSON.stringify({
        type: 'hello',
        protocol: 1,
        pairCode: pairing.code,
        clientId,
        cols: 80,
        rows: 24,
      }),
    );
    return { client, ready: await ready, session: await started, seen: collect(client) };
  };
  t.onTestFinished(() => host.close());
  return { host, toHost, open };
}

test('ready carries the font; slices route to the asking window only', async (t) => {
  const { host, toHost, open } = await startStack(t);
  const a = await open('window-a');
  const b = await open('window-b');
  t.onTestFinished(() => {
    a.client.close();
    b.client.close();
  });

  assert.deepEqual(a.ready.terminalFont, FONT);

  // Not announced, or out of range: answered by the relay, never forwarded.
  a.client.send(
    JSON.stringify({ type: 'host_font_chunk_request', sha256: 'c'.repeat(64), index: 0 }),
  );
  a.client.send(JSON.stringify({ type: 'host_font_chunk_request', sha256: BOLD, index: 1 }));
  await settle();
  assert.equal(toHost.filter((message) => message.type === 'host_font_chunk_request').length, 0);
  assert.equal(a.seen.filter((message) => message.code === 'host_font_unavailable').length, 2);

  const forwarded = nextMessage(host, (message) => message.type === 'host_font_chunk_request');
  a.client.send(JSON.stringify({ type: 'host_font_chunk_request', sha256: REGULAR, index: 2 }));
  const request = await forwarded;
  assert.equal(request.streamId, a.session.streamId);

  const delivered = nextMessage(a.client, (message) => message.type === 'host_font_chunk');
  host.send(
    JSON.stringify({
      type: 'host_font_chunk',
      clientId: request.streamId,
      sha256: REGULAR,
      index: 2,
      total: 3,
      dataBase64: 'AAAA',
    }),
  );
  assert.deepEqual(await delivered, {
    type: 'host_font_chunk',
    sha256: REGULAR,
    index: 2,
    total: 3,
    dataBase64: 'AAAA',
  });
  await settle();
  assert.equal(
    b.seen.some((message) => message.type === 'host_font_chunk'),
    false,
  );
});

test('a window gets only a few slices in flight at once', async (t) => {
  const { toHost, open } = await startStack(t);
  const a = await open('window-a');
  t.onTestFinished(() => a.client.close());

  for (let i = 0; i < 6; i += 1) {
    a.client.send(
      JSON.stringify({ type: 'host_font_chunk_request', sha256: REGULAR, index: i % 3 }),
    );
  }
  await settle();
  assert.equal(toHost.filter((message) => message.type === 'host_font_chunk_request').length, 4);
});

test('a refresh reaches the host once, and its answer reaches every window', async (t) => {
  const { host, toHost, open } = await startStack(t);
  const a = await open('window-a');
  const b = await open('window-b');
  t.onTestFinished(() => {
    a.client.close();
    b.client.close();
  });

  a.client.send(JSON.stringify({ type: 'host_font_refresh' }));
  a.client.send(JSON.stringify({ type: 'host_font_refresh' }));
  await settle();
  assert.equal(toHost.filter((message) => message.type === 'host_font_refresh').length, 1);

  const changed = { family: 'Fira Code', sizePx: 14, source: 'kitty', faces: [], subsets: [] };
  const toA = nextMessage(a.client, (message) => message.type === 'terminal_font');
  const toB = nextMessage(b.client, (message) => message.type === 'terminal_font');
  host.send(JSON.stringify({ type: 'terminal_font', terminalFont: changed }));
  assert.deepEqual((await toA).terminalFont, changed);
  assert.deepEqual((await toB).terminalFont, changed);

  // A window that opens later is told the new font in its `ready`.
  const c = await open('window-c');
  t.onTestFinished(() => c.client.close());
  assert.deepEqual(c.ready.terminalFont, changed);
});

test('a large font is cut for the asking window; only that window may pull the cut', async (t) => {
  const { host, toHost, open } = await startStack(t);
  const a = await open('window-a');
  const b = await open('window-b');
  t.onTestFinished(() => {
    a.client.close();
    b.client.close();
  });

  // Only an announced source, with a sane request id.
  a.client.send(
    JSON.stringify({
      type: 'host_font_subset_request',
      sha256: REGULAR,
      text: '你好',
      requestId: 'r1',
    }),
  );
  a.client.send(
    JSON.stringify({
      type: 'host_font_subset_request',
      sha256: CJK,
      text: '你好',
      requestId: 'no spaces',
    }),
  );
  await settle();
  assert.equal(toHost.filter((message) => message.type === 'host_font_subset_request').length, 0);

  const forwarded = nextMessage(host, (message) => message.type === 'host_font_subset_request');
  a.client.send(
    JSON.stringify({
      type: 'host_font_subset_request',
      sha256: CJK,
      text: '你好',
      requestId: 'r2',
    }),
  );
  const request = await forwarded;
  assert.equal(request.streamId, a.session.streamId);
  assert.equal(request.text, '你好');

  // Small: the font rides in the answer.
  const inline = nextMessage(a.client, (message) => message.type === 'host_font_subset_ready');
  host.send(
    JSON.stringify({
      type: 'host_font_subset_ready',
      clientId: request.streamId,
      requestId: 'r2',
      sha256: CJK,
      subsetSha: 'd'.repeat(64),
      bytes: 3,
      dataBase64: 'AAAA',
    }),
  );
  assert.equal((await inline).dataBase64, 'AAAA');

  // Large: announced, then pulled in slices — by this window only.
  const big = 'e'.repeat(64);
  const announced = nextMessage(
    a.client,
    (message) => message.type === 'host_font_subset_ready' && message.subsetSha === big,
  );
  host.send(
    JSON.stringify({
      type: 'host_font_subset_ready',
      clientId: request.streamId,
      requestId: 'r3',
      sha256: CJK,
      subsetSha: big,
      bytes: TERMINAL_FONT_CHUNK_BYTES + 1,
    }),
  );
  await announced;
  const pulled = nextMessage(host, (message) => message.type === 'host_font_chunk_request');
  a.client.send(JSON.stringify({ type: 'host_font_chunk_request', sha256: big, index: 1 }));
  assert.equal((await pulled).sha256, big);

  b.client.send(JSON.stringify({ type: 'host_font_chunk_request', sha256: big, index: 0 }));
  await settle();
  assert.equal(toHost.filter((message) => message.type === 'host_font_chunk_request').length, 1);
  assert.equal(
    b.seen.some((message) => message.code === 'host_font_unavailable'),
    true,
  );
  assert.equal(
    b.seen.some((message) => message.type === 'host_font_subset_ready'),
    false,
  );
});
