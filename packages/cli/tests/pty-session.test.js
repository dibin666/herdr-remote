import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty-session.js';

function fakeTerminal() {
  return {
    pid: 1234,
    cols: 80,
    rows: 24,
    onData() {
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
    write() {},
    resize() {},
    kill() {},
  };
}

test('Windows PTYs use node-pty bundled ConPTY', (t) => {
  let spawnOptions;
  const session = new PtySession({
    command: 'herdr.exe',
    platform: 'win32',
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      return fakeTerminal();
    },
  });
  t.onTestFinished(() => session.kill());

  session.start({});

  assert.equal(spawnOptions.useConptyDll, true);
});

test('non-Windows PTYs do not set a ConPTY option', (t) => {
  let spawnOptions;
  const session = new PtySession({
    command: 'herdr',
    platform: 'linux',
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      return fakeTerminal();
    },
  });
  t.onTestFinished(() => session.kill());

  session.start({});

  assert.equal(Object.hasOwn(spawnOptions, 'useConptyDll'), false);
});

test('PTY sessions run a real terminal child with plugin context removed', async (t) => {
  const output = [];
  const session = new PtySession({
    command: process.execPath,
    args: ['-e', 'process.stdout.write((process.env.HERDR_ENV || "missing") + "\\n")'],
    cwd: process.cwd(),
    socketPath: '/tmp/herdr-test.sock',
  });
  t.onTestFinished(() => session.kill());
  const exited = new Promise((resolve) => {
    session.start({
      cols: 40,
      rows: 10,
      onData: (data) => output.push(data),
      onExit: resolve,
    });
  });
  const exit = await exited;
  assert.equal(exit.exitCode, 0);
  assert.match(output.join(''), /missing/);
  assert.equal(session.info().pid, null);
});
