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

test('the Herdr client is not told it draws in the terminal that started herdr-remote', () => {
  // Herdr 0.9.2+ sends images as local file paths to a client that believes
  // it runs in Ghostty, kitty or WezTerm; the browser can open none of them.
  const env = PtySession.childEnv('/run/herdr.sock', {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'kept',
    TERM: 'xterm-ghostty',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2.0',
    KITTY_WINDOW_ID: '3',
    WT_SESSION: 'abc',
    TMUX: '/tmp/tmux-1000/default,1,0',
    HERDR_PANE_ID: 'w1:p1',
  });

  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.HERDR_SOCKET_PATH, '/run/herdr.sock');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'kept');
  for (const key of [
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'KITTY_WINDOW_ID',
    'WT_SESSION',
    'TMUX',
    'HERDR_PANE_ID',
  ]) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach the Herdr client`);
  }
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
