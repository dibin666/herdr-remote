import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../src/relay-server';
import { nextJson, openWebSocket, relayConfig as config } from './helpers.js';

async function startRelay(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-relay-pair-limit-'));
  const relay = new RelayServer(config(), {
    stateFile: path.join(directory, 'auth.json'),
    trustProxy: true,
  });
  const address = await relay.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    await relay.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${address.port}`, wsBase: `ws://127.0.0.1:${address.port}` };
}

/** The error code the relay answers a wrong pairing code with. */
async function guessPairCode(wsBase, forwardedFor) {
  const ws = await openWebSocket(`${wsBase}/ws/client`, {
    headers: { 'X-Forwarded-For': forwardedFor },
  });
  try {
    const answer = nextJson(ws, (message) => message.type === 'error');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, pairCode: 'ZZZZZZ' }));
    return (await answer).code;
  } finally {
    ws.close();
  }
}

test('pairing guesses cannot dodge the rate limit by spoofing X-Forwarded-For', async (t) => {
  const { wsBase } = await startRelay(t);
  // nginx's $proxy_add_x_forwarded_for appends the real peer to whatever the
  // client sent, so only the right-most entry is trustworthy.
  for (let i = 0; i < 20; i += 1)
    assert.equal(await guessPairCode(wsBase, `198.51.100.${i}, 203.0.113.7`), 'auth_required');
  assert.equal(await guessPairCode(wsBase, '198.51.100.99, 203.0.113.7'), 'rate_limited');
});

test('pair start cannot dodge the rate limit by spoofing X-Forwarded-For', async (t) => {
  const { base } = await startRelay(t);
  const pairStart = (forwardedFor) =>
    fetch(`${base}/api/pair/start`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': forwardedFor },
    }).then((response) => response.status);
  for (let i = 0; i < 20; i += 1)
    assert.equal(await pairStart(`198.51.100.${i}, 203.0.113.7`), 401);
  assert.equal(await pairStart('198.51.100.99, 203.0.113.7'), 429);
});

test('wrong pairing codes are capped relay-wide across many addresses', async (t) => {
  const { wsBase } = await startRelay(t);
  for (let i = 0; i < 120; i += 1)
    assert.equal(await guessPairCode(wsBase, `203.0.113.${i}`), 'auth_required');
  assert.equal(await guessPairCode(wsBase, '192.0.2.1'), 'rate_limited');
});
