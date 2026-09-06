'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  checkForUpdate,
  compareVersions,
  currentVersion,
  installKind,
  performUpdate,
} = require('../src/updater');

test('version comparison orders releases numerically, not as text', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1, '10 is newer than 9');
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.3.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  // A prerelease suffix is ignored rather than crashing the check.
  assert.equal(compareVersions('0.2.2-beta.1', '0.2.1'), 1);
});

test('an available update is reported when the registry is ahead', async () => {
  const result = await checkForUpdate({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.latest, '99.0.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.current, currentVersion());
});

test('the installed version is not reported as an update', async () => {
  const result = await checkForUpdate({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: currentVersion() }) }),
  });
  assert.equal(result.updateAvailable, false);
});

// An update check is a convenience. A machine that is offline, behind a proxy
// or facing a broken registry must still get a usable settings screen, so the
// check reports a failure instead of throwing into the render.
test('a failing registry never throws', async () => {
  const offline = await checkForUpdate({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.errorKey, 'update.errorNetwork');
  assert.equal(offline.current, currentVersion());

  const broken = await checkForUpdate({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(broken.ok, false);

  const garbage = await checkForUpdate({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(garbage.ok, false);
});

test('a request that hangs is abandoned rather than wedging the screen', async () => {
  const result = await checkForUpdate({
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorNetwork');
});

// The test suite runs from the repository, so this copy is a checkout. Updating
// must refuse: `npm install -g` over a working tree would replace the source
// someone is editing.
test('a source checkout refuses to self-update', async () => {
  assert.equal(installKind(), 'source');

  let spawned = false;
  const result = await performUpdate({ spawnImpl: () => { spawned = true; } });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.cannot.source');
  assert.equal(spawned, false, 'npm must not be invoked against a checkout');
});

test('a failed npm install surfaces npm\'s own output', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const pending = performUpdate({
    spawnImpl: () => child,
    // The suite runs from a checkout, so the guard is bypassed to reach the
    // path an npm-installed copy would actually take.
    installKindImpl: () => 'npm',
  });
  child.emit('error', new Error('spawn npm ENOENT'));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorFailed');
  assert.match(result.output, /ENOENT/, "npm's own message is kept");
});

test('a clean npm exit reports success', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const pending = performUpdate({ spawnImpl: () => child, installKindImpl: () => 'npm' });
  child.stdout.emit('data', 'added 1 package');
  child.emit('close', 0);

  assert.equal((await pending).ok, true);
});

// The check used to ask registry.npmjs.org and nothing else, so on a machine
// that installs packages perfectly well through a mirror it reported "could
// not reach npm registry" forever. Whatever npm itself is configured to use
// comes first now.
test('the check follows the registry npm itself is configured with', () => {
  const { registryCandidates, DEFAULT_REGISTRY, MIRROR_REGISTRY } = require('../src/updater');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-npmrc-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-project-'));
  fs.writeFileSync(path.join(home, '.npmrc'), '# comment\nregistry=https://registry.npmmirror.com/\n');

  const fromEnv = registryCandidates({ env: { npm_config_registry: 'https://npm.internal/' }, home, cwd });
  assert.equal(fromEnv[0], 'https://npm.internal');
  assert.equal(fromEnv.includes(DEFAULT_REGISTRY), true, 'the public registry stays as a fallback');

  const fromNpmrc = registryCandidates({ env: {}, home, cwd });
  assert.equal(fromNpmrc[0], 'https://registry.npmmirror.com');

  const plain = registryCandidates({ env: {}, home: cwd, cwd });
  assert.deepEqual(plain, [DEFAULT_REGISTRY, MIRROR_REGISTRY]);
});

test('a registry that cannot be reached falls through to the next one', async () => {
  const asked = [];
  const result = await checkForUpdate({
    registries: ['https://npm.internal', 'https://registry.npmmirror.com'],
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.startsWith('https://npm.internal')) throw new Error('getaddrinfo ENOTFOUND');
      return { ok: true, json: async () => ({ version: '99.0.0' }) };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.latest, '99.0.0');
  assert.equal(result.registry, 'https://registry.npmmirror.com');
  assert.equal(asked.length, 2, 'every candidate is tried until one answers');
});

test('a total failure names every registry it tried', async () => {
  const result = await checkForUpdate({
    registries: ['https://npm.internal', 'https://registry.npmmirror.com'],
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorNetwork');
  assert.match(result.message, /npm\.internal/);
  assert.match(result.message, /npmmirror/);
});

test('an install runs against the registry that answered the check', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const promise = performUpdate({
    installKindImpl: () => 'npm',
    registry: 'https://registry.npmmirror.com/',
    spawnImpl: (command, args) => { calls.push([command, args]); return child; },
  });
  child.emit('close', 0);
  assert.equal((await promise).ok, true);
  assert.deepEqual(calls[0][1], ['install', '-g', 'herdr-remote@latest', '--registry', 'https://registry.npmmirror.com']);
});
