// `herdr-remote start` under a keep-alive manager.
//
// Herdr runs `herdr-remote start` from the plugin's startup hook every time a
// Herdr server starts. Restarting a service that is already up there dropped
// every browser attached to the workstation, so start only starts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import * as lifecycle from '../src/lifecycle.js';

// Should the keep-alive mock below ever stop applying, lifecycle falls through
// to the real service layer; keep it out of the real home directory.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-lifecycle-'));
process.env.HERDR_REMOTE_CONFIG_DIR = path.join(home, 'config');
process.env.HERDR_REMOTE_STATE_DIR = path.join(home, 'state');

// The keep-alive manager as lifecycle sees it: a status to report, and a
// restart that is only counted.
const manager = vi.hoisted(() => ({ status: null, restarts: [] }));

vi.mock('../src/keepalive/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  status: () => manager.status,
  restart: () => {
    manager.restarts.push(true);
    return { ok: true };
  },
}));

function withKeepalive(status, run) {
  manager.status = status;
  manager.restarts = [];
  return run(lifecycle, manager.restarts);
}

const config = { keepalive: { manager: 'auto' } };

test('start leaves a running managed service alone', () => {
  withKeepalive({ manager: 'systemd', installed: true, active: true }, (lifecycle, restarts) => {
    const result = lifecycle.startAll(config);
    assert.equal(restarts.length, 0);
    assert.equal(result.managed, true);
    assert.equal(result.alreadyRunning, true);
  });
});

test('start brings up a managed service that is not running', () => {
  withKeepalive({ manager: 'systemd', installed: true, active: false }, (lifecycle, restarts) => {
    const result = lifecycle.startAll(config);
    assert.equal(restarts.length, 1);
    assert.equal(result.alreadyRunning, false);
  });
});

test('restart still restarts', () => {
  withKeepalive({ manager: 'systemd', installed: true, active: true }, (lifecycle, restarts) => {
    lifecycle.restartAll(config);
    assert.equal(restarts.length, 1);
  });
});
