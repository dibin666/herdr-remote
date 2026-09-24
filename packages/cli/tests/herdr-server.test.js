'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const {
  probeHerdrServer,
  runningInSystemdService,
  serverCommand,
  serverEnv,
  ensureHerdrServer,
} = require('../src/herdr-server');

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('no socket file means Herdr is stopped', async (t) => {
  const socketPath = path.join(tempDir(t, 'herdr-probe-missing-'), 'herdr.sock');
  assert.deepEqual(await probeHerdrServer(socketPath), { state: 'stopped' });
});

test('a socket that accepts is a running Herdr', async (t) => {
  const socketPath = path.join(tempDir(t, 'herdr-probe-live-'), 'herdr.sock');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  assert.deepEqual(await probeHerdrServer(socketPath), { state: 'running' });
});

test('a socket file nothing listens on is a stopped Herdr, not a running one', async (t) => {
  // What a crashed or power-cut Herdr leaves behind. A `herdr` client pointed
  // at it starts its own server, which is exactly what must not happen here.
  const socketPath = path.join(tempDir(t, 'herdr-probe-stale-'), 'herdr.sock');
  // A listener killed outright never gets to unlink its socket.
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`]);
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

test('only a process running as a systemd service wraps Herdr in a scope of its own', () => {
  const service = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr-remote.service\n';
  const terminal = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n';
  assert.equal(runningInSystemdService({ platform: 'linux', readCgroup: service }), true);
  assert.equal(runningInSystemdService({ platform: 'linux', readCgroup: terminal }), false);
  assert.equal(runningInSystemdService({ platform: 'darwin', readCgroup: service }), false);
  assert.equal(runningInSystemdService({ platform: 'linux', readCgroup: () => { throw new Error('no /proc'); } }), false);

  assert.deepEqual(
    serverCommand({ command: '/usr/bin/herdr', args: ['--session', 'work'], inService: false }),
    { file: '/usr/bin/herdr', args: ['--session', 'work', 'server'] },
  );
  const scoped = serverCommand({ command: '/usr/bin/herdr', args: ['--session', 'work'], inService: true });
  assert.equal(scoped.file, 'systemd-run');
  assert.deepEqual(scoped.args.slice(0, 2), ['--user', '--scope']);
  assert.deepEqual(scoped.args.slice(scoped.args.indexOf('--') + 1), ['/usr/bin/herdr', '--session', 'work', 'server']);
});

test('the server gets the configured socket and none of the caller\'s Herdr variables', () => {
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
    launch: () => { launched = true; return new EventEmitter(); },
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
      probe: async () => ({ state: 'unavailable', reason: 'socket is not owned by the current user' }),
      launch: () => { launched = true; return new EventEmitter(); },
    }),
    /not owned by the current user/,
  );
  assert.equal(launched, false);
});

test('a stopped Herdr is started with this workstation\'s own command, arguments and socket', async (t) => {
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
    launch: (options) => { launchedWith = options; return new EventEmitter(); },
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
    (error) => /exited \(code 1\)/.test(error.message) && /address already in use/.test(error.message),
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
