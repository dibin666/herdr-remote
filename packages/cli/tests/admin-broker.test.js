import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'vitest';
import {
  adminBrokerStatus,
  adminBrokerTaskScript,
  serveAdminBroker,
  stopAdminBroker,
} from '../src/connector/admin-broker.js';
import { PACKAGE_ROOT } from '../src/paths.js';
import { isolateState } from './helpers.js';

async function startBroker(t, options) {
  const server = serveAdminBroker(options);
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

test('the broker task runs outside the package, which npm renames to update it', (t) => {
  isolateState(t);
  const match = /-WorkingDirectory '((?:[^']|'')*)'/.exec(adminBrokerTaskScript());
  assert.ok(match, 'the task sets no working directory');
  const directory = match[1].replaceAll("''", "'");
  assert.notEqual(path.resolve(directory), path.resolve(PACKAGE_ROOT));
  assert.equal(directory, process.env.HERDR_REMOTE_STATE_DIR);
});

test('an idle broker exits when asked, so its task can start the new release', async (t) => {
  isolateState(t);
  let shutdowns = 0;
  await startBroker(t, { onShutdown: () => (shutdowns += 1) });

  assert.equal(await stopAdminBroker(), 'stopped');
  assert.equal(shutdowns, 1);
  assert.equal(await adminBrokerStatus(), false);
});

test('a broker with an open administrator terminal stays, as that terminal may be asking', async (t) => {
  isolateState(t);
  let shutdowns = 0;
  const terminal = {
    pid: 4321,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
  const { port, token } = await startBroker(t, {
    spawn: () => terminal,
    onShutdown: () => (shutdowns += 1),
  });
  const session = net.createConnection({ host: '127.0.0.1', port });
  t.onTestFinished(() => session.destroy());
  session.setEncoding('utf8');
  await once(session, 'connect');
  session.write(
    `${JSON.stringify({ type: 'start', token, command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: 'C:\\' })}\n`,
  );
  const [started] = await once(session, 'data');
  assert.match(started, /"type":"started"/);

  assert.equal(await stopAdminBroker(), 'busy');
  assert.equal(shutdowns, 0);
  assert.equal(await adminBrokerStatus(), true);
});

test('stopping reports unavailable when no broker has published an endpoint', async (t) => {
  isolateState(t);
  assert.equal(await stopAdminBroker(), 'unavailable');
});
