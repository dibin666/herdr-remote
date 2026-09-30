import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import { installLatencyControls } from './lib/latency-controls.mjs';
import { enqueueDelayedSend } from '../packages/relay/src/server/transport';
import { postJson } from '../packages/relay/tests/helpers.js';

async function start(t) {
  const relay = {
    server: http.createServer((_req, res) => res.end('original WebUI')),
    devLatencyMs: 100,
    devDelayMs: 50,
    activeDelayTimers: new Set(),
    sendQueues: new WeakMap(),
  };
  installLatencyControls(relay, async () => 'http://127.0.0.1/?pairCode=ABCDEF');
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => {
    for (const timer of relay.activeDelayTimers) clearTimeout(timer);
    await new Promise((resolve) => relay.server.close(resolve));
  });
  return { relay, base: `http://127.0.0.1:${relay.server.address().port}` };
}

test('test WebUI can change round-trip latency without replacing normal routes', async (t) => {
  const { relay, base } = await start(t);
  assert.equal(await (await fetch(base)).text(), 'original WebUI');
  assert.match(await (await fetch(`${base}/__test__`)).text(), /id="latency"/);
  const state = await (await fetch(`${base}/__test__/state`)).json();
  assert.equal(state.latencyMs, 100);
  for (const latencyMs of [0, 50, 200, 800, 1_500, 5_000]) {
    const changed = await postJson(`${base}/__test__/latency?ms=${latencyMs}`);
    assert.equal(changed.latencyMs, latencyMs);
    assert.equal(relay.devDelayMs, latencyMs / 2);
  }
  const pairing = await postJson(`${base}/__test__/pair`);
  assert.equal(new URL(pairing.url).pathname, '/__test__/webui');
  assert.equal(new URL(pairing.url).searchParams.get('pairCode'), 'ABCDEF');
});

test('invalid or cross-origin changes leave the active delay unchanged', async (t) => {
  const { relay, base } = await start(t);
  for (const suffix of ['', '?ms=-1', '?ms=5001', '?ms=abc', '?ms=1.5']) {
    assert.equal(
      (await fetch(`${base}/__test__/latency${suffix}`, { method: 'POST' })).status,
      400,
    );
    assert.equal(relay.devLatencyMs, 100);
  }
  const denied = await fetch(`${base}/__test__/latency?ms=0`, {
    method: 'POST',
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(denied.status, 403);
  assert.equal(relay.devLatencyMs, 100);
});

test('switching to zero drains earlier frames before applying the new delay', async (t) => {
  const { relay, base } = await start(t);
  const sent = [];
  enqueueDelayedSend(relay, new EventEmitter(), () => sent.push('old input'));
  await postJson(`${base}/__test__/latency?ms=0`);
  assert.deepEqual(sent, ['old input']);
  assert.equal(relay.activeDelayTimers.size, 0);
  assert.equal(relay.devLatencyMs, 0);
  assert.equal(relay.devDelayMs, 0);
});
