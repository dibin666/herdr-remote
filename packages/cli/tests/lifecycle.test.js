'use strict';

// `herdr-remote start` under a keep-alive manager.
//
// Herdr runs `herdr-remote start` from the plugin's startup hook every time a
// Herdr server starts. Restarting a service that is already up there dropped
// every browser attached to the workstation, so start only starts.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepalive = require('../src/keepalive');

function withKeepalive(status, run) {
  const saved = { status: keepalive.status, restart: keepalive.restart };
  const restarts = [];
  keepalive.status = () => status;
  keepalive.restart = () => {
    restarts.push(true);
    return { ok: true };
  };
  // lifecycle binds keepalive's exports at call time through the module object.
  delete require.cache[require.resolve('../src/lifecycle')];
  const lifecycle = require('../src/lifecycle');
  try {
    return run(lifecycle, restarts);
  } finally {
    keepalive.status = saved.status;
    keepalive.restart = saved.restart;
    delete require.cache[require.resolve('../src/lifecycle')];
  }
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
