import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  admitUnelevatedClients,
  ensureHerdrServer,
  launchHerdrServer,
  probeHerdrServer,
  runningElevated,
  runningInSystemdService,
  serverCommand,
  serverEnv,
} from '../src/herdr-server.js';
import { tempDir } from './helpers.js';

test('no socket file means Herdr is stopped', async (t) => {
  const socketPath = path.join(tempDir(t, 'herdr-probe-missing-'), 'herdr.sock');
  assert.deepEqual(await probeHerdrServer(socketPath), { state: 'stopped' });
});

test('a socket that accepts is a running Herdr', async (t) => {
  const socketPath = path.join(tempDir(t, 'herdr-probe-live-'), 'herdr.sock');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.onTestFinished(() => server.close());
  assert.deepEqual(await probeHerdrServer(socketPath), { state: 'running' });
});

test('a socket file nothing listens on is a stopped Herdr, not a running one', async (t) => {
  // What a crashed or power-cut Herdr leaves behind. A `herdr` client pointed
  // at it starts its own server, which is exactly what must not happen here.
  const socketPath = path.join(tempDir(t, 'herdr-probe-stale-'), 'herdr.sock');
  // A listener killed outright never gets to unlink its socket.
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
  ]);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.ok(fs.existsSync(socketPath), 'test setup must leave a dead socket file');
  const result = await probeHerdrServer(socketPath);
  assert.equal(result.state, 'stopped');
  assert.equal(result.stale, true);
});

test('a path that is not a socket is unavailable, never stopped', async (t) => {
  const socketPath = path.join(tempDir(t, 'herdr-probe-file-'), 'herdr.sock');
  fs.writeFileSync(socketPath, 'not a socket');
  const result = await probeHerdrServer(socketPath);
  assert.equal(result.state, 'unavailable');
  assert.match(result.reason, /not a Unix socket/);
});

/** A connect that fails the way a Windows named pipe refuses a client. */
function refusingConnect(code) {
  return () => {
    const socket = new net.Socket();
    setImmediate(() =>
      socket.emit(
        'error',
        Object.assign(new Error(`connect ${code} \\\\.\\pipe\\herdr`), { code }),
      ),
    );
    return socket;
  };
}

test('a Windows Herdr that refuses this process as unelevated says how to let it in', async (t) => {
  // From Herdr 0.9.4 a server started as administrator only admits
  // administrator clients, and the pipe answers everyone else with access denied.
  const socketPath = path.join(tempDir(t, 'herdr-probe-elevated-'), 'herdr.sock');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.onTestFinished(() => server.close());

  for (const code of ['EPERM', 'EACCES']) {
    const result = await probeHerdrServer(socketPath, {
      connect: refusingConnect(code),
      platform: 'win32',
    });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.elevated, true);
    assert.match(result.reason, /administrator/);
    assert.match(result.reason, /allow_unelevated_clients = true/);
    assert.match(result.reason, new RegExp(code));
  }

  // Elsewhere access denied is an ordinary permissions problem.
  const unix = await probeHerdrServer(socketPath, {
    connect: refusingConnect('EACCES'),
    platform: 'linux',
  });
  assert.equal(unix.state, 'unavailable');
  assert.equal(unix.elevated, undefined);
  assert.doesNotMatch(unix.reason, /administrator/);
});

test('an administrator token is told from an ordinary one by its integrity level', () => {
  const groups = (level) => () =>
    `"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\${level}","Label","${
      { medium: 'S-1-16-8192', high: 'S-1-16-12288', system: 'S-1-16-16384' }[level]
    }",""\r\n`;
  assert.equal(runningElevated({ platform: 'win32', whoamiGroups: groups('medium') }), false);
  assert.equal(runningElevated({ platform: 'win32', whoamiGroups: groups('high') }), true);
  assert.equal(runningElevated({ platform: 'win32', whoamiGroups: groups('system') }), true);
  assert.equal(runningElevated({ platform: 'linux', whoamiGroups: groups('high') }), false);
  assert.equal(
    runningElevated({
      platform: 'win32',
      whoamiGroups: () => {
        throw new Error('no whoami');
      },
    }),
    false,
  );
});

/** A stub `herdr` whose `--version` prints `line`. */
function versionStub(t, line) {
  const binary = path.join(tempDir(t, 'herdr-version-'), 'herdr');
  fs.writeFileSync(binary, `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
  return binary;
}

test.runIf(process.platform !== 'win32')(
  'an elevated herdr-remote lets ordinary clients into the Herdr it starts, when that Herdr can',
  (t) => {
    // From 0.9.4 an elevated server admits only administrator clients, which
    // would lock the user's own terminal out of the server started for them.
    assert.equal(admitUnelevatedClients(versionStub(t, 'herdr 0.9.4'), true), true);
    assert.equal(admitUnelevatedClients(versionStub(t, 'herdr 0.10.0'), true), true);
    // An older Herdr refuses the flag and would not start at all.
    assert.equal(admitUnelevatedClients(versionStub(t, 'herdr 0.9.3'), true), false);
    assert.equal(admitUnelevatedClients(versionStub(t, ''), true), false);
    // Started as an ordinary user, Herdr is not elevated and needs nothing.
    assert.equal(admitUnelevatedClients(versionStub(t, 'herdr 0.9.4'), false), false);
  },
);

test("the flag follows `server`, after Herdr's own global arguments", (t) => {
  assert.deepEqual(
    serverCommand({
      command: 'C:\\herdr.exe',
      args: ['--session', 'work'],
      inService: false,
      allowUnelevated: true,
    }),
    {
      file: 'C:\\herdr.exe',
      args: ['--session', 'work', 'server', '--allow-unelevated-clients'],
    },
  );

  let spawned = null;
  launchHerdrServer({
    command: 'C:\\herdr.exe',
    socketPath: 'herdr',
    logPath: path.join(tempDir(t, 'herdr-launch-'), 'herdr-server.log'),
    inService: false,
    allowUnelevated: true,
    spawnProcess: (file, args) => {
      spawned = { file, args };
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });
  assert.deepEqual(spawned, {
    file: 'C:\\herdr.exe',
    args: ['server', '--allow-unelevated-clients'],
  });
});

test('only a process running as a systemd service wraps Herdr in a scope of its own', () => {
  const service = () =>
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr-remote.service\n';
  const terminal = () =>
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n';
  assert.equal(runningInSystemdService({ platform: 'linux', readCgroup: service }), true);
  assert.equal(runningInSystemdService({ platform: 'linux', readCgroup: terminal }), false);
  assert.equal(runningInSystemdService({ platform: 'darwin', readCgroup: service }), false);
  assert.equal(
    runningInSystemdService({
      platform: 'linux',
      readCgroup: () => {
        throw new Error('no /proc');
      },
    }),
    false,
  );

  assert.deepEqual(
    serverCommand({ command: '/usr/bin/herdr', args: ['--session', 'work'], inService: false }),
    { file: '/usr/bin/herdr', args: ['--session', 'work', 'server'] },
  );
  const scoped = serverCommand({
    command: '/usr/bin/herdr',
    args: ['--session', 'work'],
    inService: true,
  });
  assert.equal(scoped.file, 'systemd-run');
  assert.deepEqual(scoped.args.slice(0, 2), ['--user', '--scope']);
  assert.deepEqual(scoped.args.slice(scoped.args.indexOf('--') + 1), [
    '/usr/bin/herdr',
    '--session',
    'work',
    'server',
  ]);
});

test("the server gets the configured socket and none of the caller's Herdr variables", () => {
  const env = serverEnv('/home/me/.config/herdr/herdr.sock', {
    PATH: '/usr/bin',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: '/somewhere/else.sock',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HERDR_PANE_ID, undefined);
  assert.equal(env.HERDR_SOCKET_PATH, '/home/me/.config/herdr/herdr.sock');
});

test('a running Herdr is left alone', async () => {
  let launched = false;
  const result = await ensureHerdrServer({
    command: 'herdr',
    socketPath: '/tmp/herdr.sock',
    logPath: '/tmp/unused.log',
    probe: async () => ({ state: 'running' }),
    launch: () => {
      launched = true;
      return new EventEmitter();
    },
  });
  assert.deepEqual(result, { started: false });
  assert.equal(launched, false);
});

test('a socket that is not ours is refused before anything starts', async () => {
  let launched = false;
  await assert.rejects(
    ensureHerdrServer({
      command: 'herdr',
      socketPath: '/tmp/herdr.sock',
      logPath: '/tmp/unused.log',
      probe: async () => ({
        state: 'unavailable',
        reason: 'socket is not owned by the current user',
      }),
      launch: () => {
        launched = true;
        return new EventEmitter();
      },
    }),
    /not owned by the current user/,
  );
  assert.equal(launched, false);
});

test("a stopped Herdr is started with this workstation's own command, arguments and socket", async (t) => {
  const logPath = path.join(tempDir(t, 'herdr-start-'), 'herdr-server.log');
  const states = ['stopped', 'stopped', 'running'];
  let launchedWith = null;
  const result = await ensureHerdrServer({
    command: '/usr/bin/herdr',
    args: ['--session', 'work'],
    socketPath: '/home/me/.config/herdr/herdr.sock',
    cwd: '/home/me',
    logPath,
    interval: 1,
    probe: async () => ({ state: states.shift() || 'running' }),
    launch: (options) => {
      launchedWith = options;
      return new EventEmitter();
    },
  });
  assert.deepEqual(result, { started: true });
  assert.deepEqual(launchedWith, {
    command: '/usr/bin/herdr',
    args: ['--session', 'work'],
    socketPath: '/home/me/.config/herdr/herdr.sock',
    cwd: '/home/me',
    logPath,
  });
});

test('a server that exits early is reported with what it printed', async (t) => {
  const logPath = path.join(tempDir(t, 'herdr-exit-'), 'herdr-server.log');
  fs.writeFileSync(logPath, 'error: address already in use\n');
  await assert.rejects(
    ensureHerdrServer({
      command: 'herdr',
      socketPath: '/tmp/herdr.sock',
      logPath,
      interval: 5,
      probe: async () => ({ state: 'stopped' }),
      launch: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('exit', 1, null));
        return child;
      },
    }),
    (error) =>
      /exited \(code 1\)/.test(error.message) && /address already in use/.test(error.message),
  );
});

test('a server that never opens its socket times out', async (t) => {
  const logPath = path.join(tempDir(t, 'herdr-timeout-'), 'herdr-server.log');
  await assert.rejects(
    ensureHerdrServer({
      command: 'herdr',
      socketPath: '/tmp/herdr.sock',
      logPath,
      interval: 5,
      timeout: 20,
      probe: async () => ({ state: 'stopped' }),
      launch: () => new EventEmitter(),
    }),
    /did not open \/tmp\/herdr\.sock/,
  );
});
