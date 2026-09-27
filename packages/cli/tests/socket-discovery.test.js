import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { tempDir } from './helpers.js';
import {
  defaultSocketPath,
  herdrEndpoint,
  inspectSocket,
  resolveSocketPath,
} from '../src/socket-discovery.js';

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

test('Windows socket discovery follows Herdr config directory precedence', (t) => {
  const home = tempDir(t, 'herdr-remote-socket-path-');
  const xdg = path.join(home, 'xdg');
  const appData = path.join(home, 'roaming');
  const userProfile = path.join(home, 'profile');
  const socket = (...parts) => path.join(...parts, 'herdr', 'herdr.sock');

  assert.equal(
    defaultSocketPath(
      { XDG_CONFIG_HOME: xdg, APPDATA: appData, USERPROFILE: userProfile },
      'win32',
    ),
    socket(xdg),
  );
  assert.equal(
    defaultSocketPath({ APPDATA: appData, USERPROFILE: userProfile }, 'win32'),
    socket(appData),
  );
  assert.equal(
    defaultSocketPath({ USERPROFILE: userProfile }, 'win32'),
    socket(userProfile, 'AppData', 'Roaming'),
  );
  assert.equal(defaultSocketPath({}, 'win32'), socket(os.homedir(), 'AppData', 'Roaming'));
  assert.equal(
    defaultSocketPath(
      {
        HERDR_SOCKET_PATH: path.join(home, 'custom.sock'),
        XDG_CONFIG_HOME: xdg,
        APPDATA: appData,
        USERPROFILE: userProfile,
      },
      'win32',
    ),
    path.join(home, 'custom.sock'),
  );
});

test('Herdr endpoint names a Windows pipe and leaves Unix paths unchanged', () => {
  const socketPath = path.join('config', 'herdr', 'herdr.sock');

  assert.equal(herdrEndpoint(socketPath, 'win32'), `\\\\.\\pipe\\${socketPath}`);
  assert.equal(herdrEndpoint(socketPath, 'linux'), socketPath);
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
