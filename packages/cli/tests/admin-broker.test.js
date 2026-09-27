import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'vitest';
import { adminBrokerStatus, serveAdminBroker } from '../src/connector/admin-broker.js';
import { isolateState } from './helpers.js';

async function startBroker(t) {
  const server = serveAdminBroker();
  t.onTestFinished(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  return JSON.parse(
    fs.readFileSync(path.join(process.env.HERDR_REMOTE_STATE_DIR, 'admin-broker.json'), 'utf8'),
  );
}

/** Send one request line and collect everything the broker answers. */
async function exchange(port, message) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  socket.write(`${JSON.stringify(message)}\n`);
  let reply = '';
  socket.on('data', (chunk) => {
    reply += chunk;
  });
  await once(socket, 'close');
  return reply;
}

test('a caller without administrator rights reaches the broker through its published endpoint', async (t) => {
  isolateState(t);
  const endpoint = await startBroker(t);
  assert.ok(Number.isInteger(endpoint.port));
  assert.match(endpoint.token, /^[0-9a-f]{64}$/);
  assert.equal(await adminBrokerStatus(), true);
});

test('the broker refuses requests that do not carry its token', async (t) => {
  isolateState(t);
  const { port } = await startBroker(t);
  assert.match(await exchange(port, { type: 'ping', token: 'guess' }), /not authorized/);
  assert.match(
    await exchange(port, {
      type: 'start',
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      cwd: 'C:\\',
    }),
    /not authorized/,
  );
});

test('status says unavailable when no broker has published an endpoint', async (t) => {
  isolateState(t);
  assert.equal(await adminBrokerStatus(), false);
});
