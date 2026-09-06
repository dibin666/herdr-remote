'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { defaultSocketPath, inspectSocket, resolveSocketPath } = require('../src/socket-discovery');

test('socket discovery prefers explicit and injected paths', () => {
  assert.equal(resolveSocketPath('/explicit.sock', { HERDR_SOCKET_PATH: '/env.sock' }), '/explicit.sock');
  assert.equal(resolveSocketPath(null, { HERDR_SOCKET_PATH: '/env.sock' }), '/env.sock');
  assert.equal(defaultSocketPath({ XDG_CONFIG_HOME: '/tmp/config' }, 'linux'), '/tmp/config/herdr/herdr.sock');
});

test('socket inspection distinguishes regular files from Unix sockets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-socket-'));
  const regularFile = path.join(directory, 'not-a-socket');
  fs.writeFileSync(regularFile, 'x');
  assert.equal(inspectSocket(regularFile).ok, false);

  const socketPath = path.join(directory, 'herdr.sock');
  const server = net.createServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  assert.equal(inspectSocket(socketPath).ok, true);
});
