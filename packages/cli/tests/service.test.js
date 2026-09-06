'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { managedPids, pidAlive, recordManagedPid, stopServices } = require('../src/service');
const { runtimeStatePath } = require('../src/config');
const { writeJsonAtomic, readJson } = require('../src/state');

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
async function withTemporaryState(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-service-'));
  const previousConfig = process.env.HERDR_REMOTE_CONFIG_DIR;
  const previousState = process.env.HERDR_REMOTE_STATE_DIR;
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  try {
    return await run(directory);
  } finally {
    if (previousConfig === undefined) delete process.env.HERDR_REMOTE_CONFIG_DIR;
    else process.env.HERDR_REMOTE_CONFIG_DIR = previousConfig;
    if (previousState === undefined) delete process.env.HERDR_REMOTE_STATE_DIR;
    else process.env.HERDR_REMOTE_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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
    await new Promise((resolve) => { setTimeout(resolve, 50); });
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

  const tracked = managedPids(state);
  assert.deepEqual(tracked, [{ pid: process.pid, name: 'relay' }]);
});

test('managedPids merges the legacy fields with the ledger and de-duplicates', () => {
  const state = {
    supervisorPid: process.pid,
    relayPid: process.pid,
    hostPid: DEAD_PID,
    managedPids: [{ name: 'relay', pid: process.pid }, { name: 'host', pid: DEAD_PID }],
  };
  const tracked = managedPids(state);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].pid, process.pid);
  // The supervisor entry wins the name, because it must be stopped first.
  assert.equal(tracked[0].name, 'supervisor');
});

test('stopServices stops everything in the ledger, including strays', async () => {
  await withTemporaryState(async () => {
    const supervisor = spawnSleeper();
    const relay = spawnSleeper();
    const host = spawnSleeper();
    // A process recorded only in the ledger — exactly the shape an orphan from
    // an earlier start takes once another writer has reset relayPid/hostPid.
    const stray = spawnSleeper();

    const state = { supervisorPid: supervisor, relayPid: relay, hostPid: host };
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
});

test('stopServices is harmless when nothing is running', async () => {
  await withTemporaryState(() => {
    writeJsonAtomic(runtimeStatePath(), { relayPid: DEAD_PID, hostPid: DEAD_PID, managedPids: [{ name: 'relay', pid: DEAD_PID }] });
    const result = stopServices();
    assert.equal(result.ok, true);
    assert.deepEqual(result.stopped, []);
  });
});
