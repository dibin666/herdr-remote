'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthStore } = require('../src/auth-store');

function makeStore(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-auth-'));
  return {
    directory,
    store: new AuthStore({
      stateFile: path.join(directory, 'auth.json'),
      pairingTtlMs: 1000,
      deviceTtlMs: 5000,
      maxDevices: 2,
      ...options,
    }),
  };
}

test('pairing code is one-time and yields a renewable device token', () => {
  const { store } = makeStore();
  const now = 1_000_000;
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', null, now).ok, true);
  const pairing = store.startPairing('host-1', 'https://herdr.example', now);
  const paired = store.completePairing(pairing.code, now + 1);
  assert.equal(paired.hostId, 'host-1');
  assert.equal(store.completePairing(pairing.code, now + 2), null);
  assert.equal(store.authenticateDevice(paired.token, now + 10).deviceId, paired.deviceId);
});

test('expired device tokens and pairings are removed', () => {
  const { store } = makeStore();
  const now = 2_000_000;
  store.registerHost('host-1', 'host-secret-123456789', null, now);
  const pairing = store.startPairing('host-1', 'http://localhost', now);
  assert.equal(store.completePairing(pairing.code, now + 2000), null);
  const validPairing = store.startPairing('host-1', 'http://localhost', now + 10);
  const device = store.completePairing(validPairing.code, now + 11);
  assert.equal(store.authenticateDevice(device.token, now + 6000), null);
  assert.equal(store.cleanup(now + 6000).removedDevices, 1);
});

test('a password gates who may join the relay', () => {
  const { store } = makeStore({ password: 'hunter2' });

  assert.equal(store.registerHost('host-1', 'host-secret-123456789', 'wrong').code, 'relay_password_required');
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', null).code, 'relay_password_required');
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', 'hunter2').ok, true);
  assert.equal(store.hostCount(), 1);
});

test('without a password the relay is public and accepts many workstations', () => {
  // A shared relay has to let strangers connect; what keeps them apart is the
  // per-workstation host token, not the door.
  const { store } = makeStore();

  assert.equal(store.registerHost('host-alice', 'alice-secret-123456789', null).ok, true);
  assert.equal(store.registerHost('host-bob', 'bob-secret-1234567890', null).ok, true);
  assert.equal(store.hostCount(), 2);
});

test('host ids reject object keys and oversized credentials', () => {
  const { store } = makeStore();
  assert.equal(store.registerHost('__proto__', 'host-secret-123456789', null).code, 'invalid_host_credentials');
  assert.equal(store.registerHost('host/unsafe', 'host-secret-123456789', null).code, 'invalid_host_credentials');
  assert.equal(store.registerHost('host-1', 'x'.repeat(4097), null).code, 'invalid_host_credentials');
});

test('a host token cannot be reused to impersonate another workstation', () => {
  const { store } = makeStore();
  store.registerHost('host-alice', 'alice-secret-123456789', null);
  store.registerHost('host-bob', 'bob-secret-1234567890', null);

  // Reconnecting with the wrong token is refused even on a public relay.
  assert.equal(store.registerHost('host-alice', 'bob-secret-1234567890', null).code, 'host_auth_failed');

  assert.equal(store.authenticateHost('host-alice', 'alice-secret-123456789'), true);
  assert.equal(store.authenticateHost('host-alice', 'bob-secret-1234567890'), false);
  assert.equal(store.authenticateHost('host-nobody', 'alice-secret-123456789'), false);
  assert.equal(store.authenticateHost('host-alice', ''), false);
});

test('re-authenticating an enrolled host still needs the relay password', () => {
  const { store } = makeStore({ password: 'hunter2' });
  store.registerHost('host-1', 'host-secret-123456789', 'hunter2');
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', 'hunter2').firstSeen, false);
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', 'nope').code, 'relay_password_required');
});
