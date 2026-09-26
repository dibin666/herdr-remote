import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DEFAULTS } from '../src/config.js';
import { EXIT_AUTH_FAILED, EXIT_REPLACED } from '../src/exit-codes.js';
import { pidAlive } from '../src/lib/process.js';
import { readRuntime, recordManagedPid, updateRuntime } from '../src/runtime.js';
import { MIN_BACKOFF_MS, Supervisor } from '../src/supervisor.js';
import { isolateState } from './helpers.js';

/** A child that runs `script` with Node; `name` must be relay or host. */
function nodeSpec(name, script) {
  return { name, command: process.execPath, args: ['-e', script], env: {} };
}

function supervisor(t, specs) {
  isolateState(t);
  const events = [];
  const instance = new Supervisor({
    config: structuredClone(DEFAULTS),
    state: {},
    specs,
    onEvent: (event) => events.push(event),
  });
  t.onTestFinished(() => instance.stop({ graceMs: 200 }));
  return { instance, events };
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition never held'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

const count = (events, type) => events.filter((event) => event.type === type).length;

test('a child that crashes is restarted, backing off further each time', async (t) => {
  const { instance, events } = supervisor(t, [nodeSpec('relay', 'process.exit(1)')]);
  await instance.start();

  await waitFor(() => count(events, 'started') >= 2);
  const entry = instance.children.get('relay');
  assert.equal(count(events, 'exited') >= 1, true);
  assert.ok(entry.restarts >= 1);
  assert.ok(entry.backoffMs > MIN_BACKOFF_MS, 'the next wait is longer than the first');
});

for (const [code, type] of [
  [EXIT_REPLACED, 'replaced'],
  [EXIT_AUTH_FAILED, 'fatal'],
]) {
  test(`a child that exits with ${code} is left stopped`, async (t) => {
    const { instance, events } = supervisor(t, [nodeSpec('host', `process.exit(${code})`)]);
    await instance.start();

    await waitFor(() => count(events, type) === 1);
    // Longer than the first restart would have taken.
    await new Promise((resolve) => setTimeout(resolve, MIN_BACKOFF_MS + 200));
    assert.equal(count(events, 'started'), 1);
    assert.equal(instance.children.get('host').timer, null);
  });
}

test('stopping ends the children, by force if they ignore SIGTERM', async (t) => {
  const { instance } = supervisor(t, [
    nodeSpec('relay', 'setInterval(() => {}, 1000)'),
    nodeSpec('host', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
  ]);
  await instance.start();
  await waitFor(() => [...instance.children.values()].every((entry) => entry.pid));
  const pids = [...instance.children.values()].map((entry) => entry.pid);
  assert.equal(readRuntime().relayPid, pids[0]);

  await instance.stop({ graceMs: 300 });

  await waitFor(() => pids.every((pid) => !pidAlive(pid)));
  const runtime = readRuntime();
  assert.equal(runtime.relayPid, null);
  assert.equal(runtime.hostPid, null);
});

test('a process an earlier start left behind is stopped before children start', async (t) => {
  const { instance, events } = supervisor(t, []);
  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.onTestFinished(() => stray.kill('SIGKILL'));
  updateRuntime((current) => recordManagedPid(current, 'relay', stray.pid));

  await instance.start();

  assert.equal(count(events, 'reclaim'), 1);
  await waitFor(() => !pidAlive(stray.pid));
});
