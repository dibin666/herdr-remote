import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty-session.js';

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
