import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { pidAlive } from '../src/lib/process.js';
import { managedPids, recordManagedPid } from '../src/runtime.js';
import { stopServices } from '../src/service.js';
import { runtimeStatePath } from '../src/paths.js';
import { writeJsonAtomic, readJson } from 'herdr-remote-relay/state';
import { isolateState, tempDir } from './helpers.js';

// A pid that is certainly not running: above the kernel maximum.
const DEAD_PID = 4194304;

/**
 * Point the config and state directories at a throwaway location.
 *
 * `await`s the body: restoring the environment synchronously around an async
 * callback would put it back before the callback ran, and these tests signal
 * whatever pids the state file names — against the real state file that means
 * killing the developer's running services.
 */
/** A detached child that stays alive until it is signalled. */
function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

test('the pid ledger appends and forgets dead entries', () => {
  const state = {};
  recordManagedPid(state, 'relay', process.pid);
  recordManagedPid(state, 'host', DEAD_PID);

  assert.equal(state.managedPids.length, 1, 'a dead pid should not be retained');
  assert.equal(state.managedPids[0].name, 'relay');

  // Re-recording the same pid replaces rather than duplicates it.
  recordManagedPid(state, 'relay', process.pid);
  assert.equal(state.managedPids.filter((entry) => entry.pid === process.pid).length, 1);
});

test('the ledger keeps pids another writer would have overwritten', () => {
  // The supervisor used to replace relayPid/hostPid wholesale, orphaning
  // whatever a previous detached start had spawned: those processes kept the
  // relay port and the host session, so nothing could bind and "stop" had
  // nothing left to kill.
  const state = { relayPid: DEAD_PID, hostPid: DEAD_PID };
  recordManagedPid(state, 'relay', process.pid);

  state.relayPid = null;
  state.hostPid = null;

  const tracked = managedPids(state).map(({ pid, name }) => ({ pid, name }));
  assert.deepEqual(tracked, [{ pid: process.pid, name: 'relay' }]);
});

test('managedPids trusts only ledger entries that still name the process recorded', () => {
  const state = {
    // Bare numbers cannot say which process they were taken from.
    supervisorPid: process.pid,
    relayPid: process.pid,
    managedPids: [
      { name: 'relay', pid: process.pid, processStart: 'an-earlier-boot:1234' },
      { name: 'host', pid: process.pid },
    ],
  };
  assert.deepEqual(managedPids(state), []);

  recordManagedPid(state, 'supervisor', process.pid);
  assert.deepEqual(
    managedPids(state).map(({ pid, name }) => ({ pid, name })),
    [{ pid: process.pid, name: 'supervisor' }],
  );
});

test('stopServices stops everything in the ledger, including strays', async (t) => {
  isolateState(t);
  const supervisor = spawnSleeper();
  const relay = spawnSleeper();
  const host = spawnSleeper();
  // A process recorded only in the ledger — exactly the shape an orphan from
  // an earlier start takes once another writer has reset relayPid/hostPid.
  const stray = spawnSleeper();

  const state = { supervisorPid: supervisor, relayPid: relay, hostPid: host };
  recordManagedPid(state, 'supervisor', supervisor);
  recordManagedPid(state, 'relay', relay);
  recordManagedPid(state, 'host', host);
  recordManagedPid(state, 'relay', stray);
  writeJsonAtomic(runtimeStatePath(), state);

  const result = stopServices();
  assert.equal(result.ok, true);
  // The supervisor has to be signalled first, or it restarts the children
  // faster than they can be stopped.
  assert.equal(result.stopped[0].name, 'supervisor');
  assert.equal(result.stopped.length, 4);

  for (const pid of [supervisor, relay, host, stray]) {
    assert.equal(await waitForExit(pid), true, `pid ${pid} should have been stopped`);
  }

  const after = readJson(runtimeStatePath(), {});
  assert.equal(after.relayPid, null);
  assert.equal(after.hostPid, null);
  assert.equal(after.supervisorPid, null);
  assert.deepEqual(after.managedPids, []);
});

test('stopServices leaves alone a process that inherited a recorded pid', async (t) => {
  isolateState(t);
  const bystander = spawnSleeper();
  t.onTestFinished(() => {
    try {
      process.kill(bystander, 'SIGKILL');
    } catch {
      // The assertion below already failed if it is gone.
    }
  });
  writeJsonAtomic(runtimeStatePath(), {
    supervisorPid: bystander,
    hostPid: bystander,
    managedPids: [
      { name: 'supervisor', pid: bystander, processStart: 'an-earlier-boot:1234' },
      { name: 'host', pid: bystander },
    ],
  });

  const result = stopServices();

  assert.deepEqual(result.stopped, []);
  assert.equal(await waitForExit(bystander, 300), false, 'the bystander must survive');
});

test('stopServices still stops what an older release recorded without start tokens', async (t) => {
  isolateState(t);
  // An older release recorded bare pids; its relay runs herdr-remote-relay.js.
  const script = path.join(tempDir(t), 'herdr-remote-relay.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const relay = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.onTestFinished(() => relay.kill('SIGKILL'));
  writeJsonAtomic(runtimeStatePath(), {
    relayPid: relay.pid,
    managedPids: [{ name: 'relay', pid: relay.pid, startedAt: new Date().toISOString() }],
  });

  const result = stopServices();

  assert.deepEqual(result.stopped, [{ name: 'relay', pid: relay.pid }]);
  assert.equal(await waitForExit(relay.pid), true);
});

test('stopServices is harmless when nothing is running', async (t) => {
  isolateState(t);
  writeJsonAtomic(runtimeStatePath(), {
    relayPid: DEAD_PID,
    hostPid: DEAD_PID,
    managedPids: [{ name: 'relay', pid: DEAD_PID }],
  });
  const result = stopServices();
  assert.equal(result.ok, true);
  assert.deepEqual(result.stopped, []);
});
