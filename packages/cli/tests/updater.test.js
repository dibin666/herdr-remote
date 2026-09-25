'use strict';

import { test } from 'vitest';
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
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
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
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
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
  const result = await performUpdate({
    spawnImpl: () => {
      spawned = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.cannot.source');
  assert.equal(spawned, false, 'npm must not be invoked against a checkout');
});

test("a failed npm install surfaces npm's own output", async () => {
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
  fs.writeFileSync(
    path.join(home, '.npmrc'),
    '# comment\nregistry=https://registry.npmmirror.com/\n',
  );

  const fromEnv = registryCandidates({
    env: { npm_config_registry: 'https://npm.internal/' },
    home,
    cwd,
  });
  assert.equal(fromEnv[0], 'https://npm.internal');
  assert.equal(fromEnv.includes(DEFAULT_REGISTRY), true, 'the public registry stays as a fallback');

  const fromNpmrc = registryCandidates({ env: {}, home, cwd });
  assert.equal(fromNpmrc[0], 'https://registry.npmmirror.com');

  const plain = registryCandidates({ env: {}, home: cwd, cwd });
  assert.deepEqual(plain, [DEFAULT_REGISTRY, MIRROR_REGISTRY]);
});

test('a registry that cannot be reached does not hide one that can', async () => {
  const result = await checkForUpdate({
    registries: ['https://npm.internal', 'https://registry.npmmirror.com'],
    fetchImpl: async (url) => {
      if (url.startsWith('https://npm.internal')) throw new Error('getaddrinfo ENOTFOUND');
      return { ok: true, json: async () => ({ version: '99.0.0' }) };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.latest, '99.0.0');
  assert.equal(result.registry, 'https://registry.npmmirror.com');
  assert.deepEqual(result.sources, ['https://registry.npmmirror.com']);
});

test('a total failure names every registry it tried', async () => {
  const result = await checkForUpdate({
    registries: ['https://npm.internal', 'https://registry.npmmirror.com'],
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorNetwork');
  assert.match(result.message, /npm\.internal/);
  assert.match(result.message, /npmmirror/);
});

/**
 * A stand-in for `npm`: each call plays the next scripted run, asynchronously,
 * the way a real child process reports.
 */
function fakeNpm(runs) {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push(args);
    const run = runs[Math.min(calls.length, runs.length) - 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (run.stdout) child.stdout.emit('data', run.stdout);
      if (run.stderr) child.stderr.emit('data', run.stderr);
      child.emit('close', run.code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

const ETARGET = [
  'npm error code ETARGET',
  'npm error notarget No matching version found for herdr-remote@0.2.16.',
  'npm error notarget In most cases you or one of your dependencies are requesting',
  'npm error A complete log of this run can be found in: /home/me/.npm/_logs/x.log',
].join('\n');

test('the newest answer wins over a mirror that has not synced the release', async () => {
  const result = await checkForUpdate({
    registries: ['https://registry.npmmirror.com', 'https://registry.npmjs.org'],
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        latest: url.startsWith('https://registry.npmmirror.com') ? '0.0.1' : '99.0.0',
      }),
    }),
  });

  assert.equal(result.latest, '99.0.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.registry, 'https://registry.npmjs.org');
  assert.deepEqual(result.behind, [
    { registry: 'https://registry.npmmirror.com', version: '0.0.1' },
  ]);
});

test('the check asks npmjs a question it answers', async () => {
  // npmjs refuses the abbreviated install format on /<package>/latest with a
  // 406. Asking that way is what sent every check to a lagging mirror.
  const asked = [];
  const result = await checkForUpdate({
    registries: ['https://registry.npmjs.org'],
    fetchImpl: async (url, { headers }) => {
      asked.push({ url, accept: headers.Accept });
      if (/vnd\.npm\.install-v1/.test(headers.Accept)) return { ok: false, status: 406 };
      if (url.endsWith('/-/package/herdr-remote/dist-tags'))
        return { ok: true, json: async () => ({ latest: '99.0.0' }) };
      return { ok: false, status: 404 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.latest, '99.0.0');
  assert.equal(asked[0].url, 'https://registry.npmjs.org/-/package/herdr-remote/dist-tags');
  assert.equal(asked[0].accept, 'application/json');
});

test('an install asks for the exact version found, revalidating what npm cached', async () => {
  const npm = fakeNpm([{ code: 0, stdout: 'changed 1 package' }]);
  const result = await performUpdate({
    installKindImpl: () => 'npm',
    registry: 'https://registry.npmmirror.com/',
    version: '0.2.16',
    spawnImpl: npm.spawnImpl,
    readInstalledVersion: () => '0.2.16',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(npm.calls[0], [
    'install',
    '-g',
    'herdr-remote@0.2.16',
    '--prefer-online',
    '--registry',
    'https://registry.npmmirror.com',
  ]);
});

test('a release npm has not caught up with yet is waited out, not reported as a failure', async () => {
  const npm = fakeNpm([{ code: 1, stderr: ETARGET }, { code: 1, stderr: ETARGET }, { code: 0 }]);
  const waits = [];
  const attempts = [];
  const result = await performUpdate({
    installKindImpl: () => 'npm',
    registry: 'https://registry.npmjs.org',
    version: '0.2.16',
    spawnImpl: npm.spawnImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    readInstalledVersion: () => '0.2.16',
    onAttempt: ({ attempt }) => attempts.push(attempt),
  });

  assert.equal(result.ok, true);
  assert.equal(npm.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('a release still missing after every wait says so, after trying each registry that has it', async () => {
  const npm = fakeNpm([{ code: 1, stderr: ETARGET }]);
  const result = await performUpdate({
    installKindImpl: () => 'npm',
    registry: 'https://registry.npmjs.org',
    sources: ['https://registry.npmjs.org', 'https://registry.npmmirror.com'],
    version: '0.2.16',
    spawnImpl: npm.spawnImpl,
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorNotYetPublished');
  assert.deepEqual(
    npm.calls.map((args) => args.at(-1)),
    [
      'https://registry.npmjs.org',
      'https://registry.npmjs.org',
      'https://registry.npmjs.org',
      'https://registry.npmmirror.com',
      'https://registry.npmmirror.com',
      'https://registry.npmmirror.com',
    ],
  );
  assert.match(result.summary, /No matching version found for herdr-remote@0\.2\.16/);
  assert.doesNotMatch(result.summary, /complete log/);
});

test("any other npm failure is not retried, and npm's own words come back", async () => {
  const npm = fakeNpm([
    {
      code: 243,
      stderr:
        'npm error code EACCES\nnpm error syscall rename\nnpm error Error: EACCES: permission denied',
    },
  ]);
  const result = await performUpdate({
    installKindImpl: () => 'npm',
    registry: 'https://registry.npmjs.org',
    version: '0.2.16',
    spawnImpl: npm.spawnImpl,
    sleep: async () => {
      throw new Error('must not wait');
    },
  });

  assert.equal(npm.calls.length, 1);
  assert.equal(result.errorKey, 'update.errorFailed');
  assert.match(result.summary, /EACCES: permission denied/);
});

test('npm reporting success while the old version stays installed is not success', async () => {
  const npm = fakeNpm([{ code: 0 }]);
  const result = await performUpdate({
    installKindImpl: () => 'npm',
    version: '0.2.16',
    spawnImpl: npm.spawnImpl,
    readInstalledVersion: () => '0.2.15',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKey, 'update.errorNotApplied');
  assert.equal(result.installed, '0.2.15');
});
