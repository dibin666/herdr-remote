import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { defaultSocketPath, inspectSocket, resolveSocketPath } from '../src/socket-discovery.js';

test('socket discovery prefers explicit and injected paths', () => {
  assert.equal(
    resolveSocketPath('/explicit.sock', { HERDR_SOCKET_PATH: '/env.sock' }),
    '/explicit.sock',
  );
  assert.equal(resolveSocketPath(null, { HERDR_SOCKET_PATH: '/env.sock' }), '/env.sock');
  assert.equal(
    defaultSocketPath({ XDG_CONFIG_HOME: '/tmp/config' }, 'linux'),
    '/tmp/config/herdr/herdr.sock',
  );
});

test('socket inspection distinguishes regular files from Unix sockets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-socket-'));
  const regularFile = path.join(directory, 'not-a-socket');
  fs.writeFileSync(regularFile, 'x');
  assert.equal(inspectSocket(regularFile).ok, false);

  const socketPath = path.join(directory, 'herdr.sock');
  const server = net.createServer();
  t.onTestFinished(() => server.close());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  assert.equal(inspectSocket(socketPath).ok, true);
});
