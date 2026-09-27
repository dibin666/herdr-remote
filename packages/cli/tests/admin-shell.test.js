import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { serveAdminBroker } from '../src/connector/admin-broker.js';
import { runAdminShell } from '../src/connector/admin-shell.js';
import { isolateState } from './helpers.js';

/** A PowerShell for the broker to start, recording what is typed into it. */
function fakePowerShell() {
  const shell = { typed: '', exit: () => {} };
  shell.spawn = () => ({
    pid: 1,
    onData: () => {},
    onExit: (listener) => {
      shell.exit = listener;
    },
    write: (data) => {
      shell.typed += data;
    },
    resize: () => {},
    kill: () => {},
  });
  return shell;
}

// The CLI asks a Windows console for its colors through stdin before any
// command runs, and pauses stdin afterwards. A stream paused that way ignores
// a new 'data' listener, so nothing typed reached the elevated PowerShell.
test('keys reach the elevated PowerShell even when stdin was paused before admin-shell', async (t) => {
  isolateState(t);
  const shell = fakePowerShell();
  const broker = serveAdminBroker({ spawn: shell.spawn });
  t.onTestFinished(() => new Promise((resolve) => broker.close(resolve)));
  await once(broker, 'listening');

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  stdin.pause();
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: () => true,
  });
  const exitCode = runAdminShell((key) => key, { stdin, stdout, platform: 'win32' });

  stdin.write('dir\r');
  const deadline = Date.now() + 2_000;
  while (!shell.typed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  shell.exit({ exitCode: 0 });

  assert.equal(shell.typed, 'dir\r');
  assert.equal(await exitCode, 0);
});
