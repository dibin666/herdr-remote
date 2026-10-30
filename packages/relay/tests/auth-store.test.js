import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth-store';

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

test('every pairing code is six characters a person can type, and pairs', (t) => {
  const { store, directory } = makeStore({ maxDevices: 4 });
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = 3_000_000;
  store.registerHost('host-1', 'host-secret-123456789', null, now);
  // Codes used to be cut from base64 with `-` and `_` dropped: one in seven came
  // out shorter than six, and about one in three thousand too short to pair.
  for (let i = 0; i < 2000; i += 1) {
    const { code } = store.startPairing('host-1', 'http://localhost', now);
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.equal(store.completePairing(code, now + 1)?.hostId, 'host-1', code);
  }
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

  assert.equal(
    store.registerHost('host-1', 'host-secret-123456789', 'wrong').code,
    'relay_password_required',
  );
  assert.equal(
    store.registerHost('host-1', 'host-secret-123456789', null).code,
    'relay_password_required',
  );
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
  assert.equal(
    store.registerHost('__proto__', 'host-secret-123456789', null).code,
    'invalid_host_credentials',
  );
  assert.equal(
    store.registerHost('host/unsafe', 'host-secret-123456789', null).code,
    'invalid_host_credentials',
  );
  assert.equal(
    store.registerHost('host-1', 'x'.repeat(4097), null).code,
    'invalid_host_credentials',
  );
});

test('a host token cannot be reused to impersonate another workstation', () => {
  const { store } = makeStore();
  store.registerHost('host-alice', 'alice-secret-123456789', null);
  store.registerHost('host-bob', 'bob-secret-1234567890', null);

  // Reconnecting with the wrong token is refused even on a public relay.
  assert.equal(
    store.registerHost('host-alice', 'bob-secret-1234567890', null).code,
    'host_auth_failed',
  );

  assert.equal(store.authenticateHost('host-alice', 'alice-secret-123456789'), true);
  assert.equal(store.authenticateHost('host-alice', 'bob-secret-1234567890'), false);
  assert.equal(store.authenticateHost('host-nobody', 'alice-secret-123456789'), false);
  assert.equal(store.authenticateHost('host-alice', ''), false);
});

test('re-authenticating an enrolled host still needs the relay password', () => {
  const { store } = makeStore({ password: 'hunter2' });
  store.registerHost('host-1', 'host-secret-123456789', 'hunter2');
  assert.equal(store.registerHost('host-1', 'host-secret-123456789', 'hunter2').firstSeen, false);
  assert.equal(
    store.registerHost('host-1', 'host-secret-123456789', 'nope').code,
    'relay_password_required',
  );
});

test('one host pairing past the device cap only evicts its own oldest devices', (t) => {
  const { store, directory } = makeStore({ maxDevices: 32, deviceTtlMs: 60_000 });
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = 4_000_000;
  store.registerHost('host-alice', 'alice-secret-123456789', null, now);
  store.registerHost('host-mallory', 'mallory-secret-1234567', null, now);
  const pairDevice = (hostId, at) =>
    store.completePairing(store.startPairing(hostId, 'http://localhost', at).code, at);

  const alice = pairDevice('host-alice', now);
  const mallory = [];
  for (let i = 1; i <= 33; i += 1) mallory.push(pairDevice('host-mallory', now + i));

  assert.equal(store.authenticateDevice(alice.token, now + 100)?.deviceId, alice.deviceId);
  assert.equal(store.authenticateDevice(mallory[0].token, now + 100), null);
  assert.equal(store.authenticateDevice(mallory[1].token, now + 100)?.hostId, 'host-mallory');
  assert.equal(store.authenticateDevice(mallory[32].token, now + 100)?.hostId, 'host-mallory');
  assert.equal(store.deviceCount(), 33);
});
