'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FALLBACK_DIRECTORIES,
  fallbackDirectories,
  findHerdrCommand,
  herdrNotFoundMessage,
  resolveHerdrCommand,
  verifyHerdrCommand,
} = require('../src/herdr-command');

/** A throwaway tree with an executable `herdr` in `directory`. */
function makeInstall(directory, { executable = true, name = 'herdr' } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, name);
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: executable ? 0o755 : 0o644 });
  return binary;
}

function withTempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-command-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/**
 * The real fallback list minus the system directories, for the cases that
 * assert nothing was found: a machine with Herdr in `/usr/local/bin` would
 * otherwise fail them for the right reasons.
 */
function homeDirectories(home) {
  return fallbackDirectories(home).filter((directory) => directory.startsWith(home));
}

test('HERDR_BIN_PATH pointing at the executable wins', (t) => {
  const home = withTempHome(t);
  const binary = makeInstall(path.join(home, 'custom'));

  const found = findHerdrCommand({ env: { HERDR_BIN_PATH: binary, PATH: '' }, home });

  assert.deepEqual(found, { command: binary, source: 'env', found: true });
});

test('HERDR_BIN_PATH pointing at the install directory is accepted too', (t) => {
  const home = withTempHome(t);
  const directory = path.join(home, '.local', 'bin');
  const binary = makeInstall(directory);

  const found = findHerdrCommand({ env: { HERDR_BIN_PATH: directory, PATH: '' }, home });

  assert.equal(found.command, binary);
  assert.equal(found.source, 'env');
});

test('a stale HERDR_BIN_PATH falls back instead of failing the spawn', (t) => {
  const home = withTempHome(t);
  const binary = makeInstall(path.join(home, '.local', 'bin'));

  const found = findHerdrCommand({
    env: { HERDR_BIN_PATH: path.join(home, 'moved-away', 'herdr'), PATH: '' },
    home,
  });

  assert.equal(found.command, binary);
  assert.equal(found.source, 'fallback');
});

test('PATH is searched before the well-known directories and resolves to an absolute path', (t) => {
  const home = withTempHome(t);
  const onPath = makeInstall(path.join(home, 'opt', 'bin'));
  makeInstall(path.join(home, '.local', 'bin'));

  const found = findHerdrCommand({ env: { PATH: path.join(home, 'opt', 'bin') }, home });

  assert.deepEqual(found, { command: onPath, source: 'path', found: true });
  assert.equal(resolveHerdrCommand({ env: { PATH: path.join(home, 'opt', 'bin') }, home }), onPath);
});

// This is the systemd --user case from issue #1: the unit's PATH has none of
// the directories the user installed into.
test('a minimal PATH still finds a ~/.local/bin install', (t) => {
  const home = withTempHome(t);
  const binary = makeInstall(path.join(home, '.local', 'bin'));
  // Stand-ins for the /usr/local/bin:/usr/bin:/bin a systemd --user unit gets.
  const minimalPath = ['usr-local-bin', 'usr-bin', 'bin'].map((name) => {
    const directory = path.join(home, 'system', name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }).join(path.delimiter);

  const found = findHerdrCommand({ env: { PATH: minimalPath }, home });

  assert.equal(found.command, binary);
  assert.equal(found.source, 'fallback');
});

test('~/.cargo/bin is probed when ~/.local/bin has nothing', (t) => {
  const home = withTempHome(t);
  const binary = makeInstall(path.join(home, '.cargo', 'bin'));

  assert.equal(findHerdrCommand({ env: { PATH: '' }, home }).command, binary);
});

test('a file without the executable bit is not a Herdr install', (t) => {
  const home = withTempHome(t);
  makeInstall(path.join(home, '.local', 'bin'), { executable: false });

  const found = findHerdrCommand({ env: { PATH: '' }, home, directories: homeDirectories(home) });

  assert.equal(found.found, false);
  assert.equal(found.source, 'unresolved');
});

test('nothing found still yields the bare name, so old behaviour is preserved', (t) => {
  const home = withTempHome(t);

  assert.equal(resolveHerdrCommand({ env: { PATH: '' }, home, directories: [] }), 'herdr');
});

test('a directory named herdr is not mistaken for the binary', (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.local', 'bin', 'herdr'), { recursive: true });

  const found = findHerdrCommand({ env: { PATH: '' }, home, directories: homeDirectories(home) });

  assert.equal(found.found, false);
});

test('the well-known directories are probed home-first', () => {
  assert.deepEqual(FALLBACK_DIRECTORIES.slice(0, 3), ['~/.local/bin', '~/.cargo/bin', '~/bin']);
  assert.ok(FALLBACK_DIRECTORIES.includes('/opt/homebrew/bin'));
  assert.ok(FALLBACK_DIRECTORIES.includes('/usr/local/bin'));
  assert.deepEqual(fallbackDirectories('/home/someone').slice(0, 2), ['/home/someone/.local/bin', '/home/someone/.cargo/bin']);
});

test('verify keeps a still-valid absolute path and re-searches a broken one', (t) => {
  const home = withTempHome(t);
  const binary = makeInstall(path.join(home, '.local', 'bin'));

  assert.deepEqual(
    verifyHerdrCommand(binary, { env: { PATH: '' }, home }),
    { command: binary, source: 'verified', found: true },
  );
  // A connector that started before Herdr existed picks it up without a restart.
  const rediscovered = verifyHerdrCommand('herdr', { env: { PATH: '' }, home });
  assert.equal(rediscovered.command, binary);
  assert.equal(rediscovered.source, 'fallback');

  fs.rmSync(binary, { force: true });
  assert.equal(
    verifyHerdrCommand(binary, { env: { PATH: '' }, home, directories: homeDirectories(home) }).found,
    false,
  );
});

test('the not-found message names the override and the directories tried', (t) => {
  const home = withTempHome(t);

  const message = herdrNotFoundMessage({ env: { HERDR_BIN_PATH: '/gone/herdr', PATH: '' }, home, directories: fallbackDirectories(home) });

  assert.match(message, /HERDR_BIN_PATH=\/gone\/herdr/);
  assert.match(message, new RegExp(path.join(home, '.local', 'bin').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, /set HERDR_BIN_PATH/i);
});
