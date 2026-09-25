// `herdr-remote start` under a keep-alive manager.
//
// Herdr runs `herdr-remote start` from the plugin's startup hook every time a
// Herdr server starts. Restarting a service that is already up there dropped
// every browser attached to the workstation, so start only starts.

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import * as lifecycle from '../src/lifecycle.js';

// The keep-alive manager as lifecycle sees it: a status to report, and a
// restart that is only counted.
const manager = vi.hoisted(() => ({ status: null, restarts: [] }));

vi.mock('../src/keepalive.js', async (importOriginal) => ({
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
