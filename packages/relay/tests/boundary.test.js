'use strict';

// The whole point of splitting the relay into its own package is that it can be
// deployed on a server that has none of the workstation-side code: no plugin,
// no Herdr, and above all no node-pty, whose native build is the reason the old
// single-package install was slow and fragile. These tests fail the moment that
// separation is broken, because the breakage is otherwise invisible until
// someone tries to install the relay on a machine without a compiler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function sourceFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.js') ? [full] : [];
  });
}

test('the relay depends on nothing but ws', () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ['ws']);
  assert.equal(manifest.dependencies['node-pty'], undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test('no relay source imports the workstation package', () => {
  const forbidden = [/require\(['"]herdr-remote['"]/, /require\(['"][^'"]*packages\/cli/, /require\(['"]node-pty['"]/];
  const offenders = [];

  for (const file of [...sourceFiles(path.join(PACKAGE_ROOT, 'src')), ...sourceFiles(path.join(PACKAGE_ROOT, 'bin'))]) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(contents)) offenders.push(`${path.relative(PACKAGE_ROOT, file)} matches ${pattern}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('no relay source reaches outside the package', () => {
  // A require that climbs above the package root would resolve during local
  // development and break in the published tarball.
  const offenders = [];
  for (const file of [...sourceFiles(path.join(PACKAGE_ROOT, 'src')), ...sourceFiles(path.join(PACKAGE_ROOT, 'bin'))]) {
    const contents = fs.readFileSync(file, 'utf8');
    const matches = contents.match(/require\(['"](\.\.?\/[^'"]+)['"]\)/g) || [];
    for (const match of matches) {
      const specifier = /require\(['"](.+)['"]\)/.exec(match)[1];
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(PACKAGE_ROOT + path.sep)) {
        offenders.push(`${path.relative(PACKAGE_ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the relay loads and serves without any workstation module present', () => {
  // Requiring the entry points is the cheapest proof that the dependency graph
  // really is self-contained.
  const { RelayServer } = require('../src/relay-server');
  const { loadRelayConfig } = require('../src/relay-config');
  assert.equal(typeof RelayServer, 'function');
  assert.equal(typeof loadRelayConfig, 'function');
  assert.equal(require.cache[require.resolve('../src/relay-server')] !== undefined, true);

  const loadedNodePty = Object.keys(require.cache).some((key) => key.includes(`${path.sep}node-pty${path.sep}`));
  assert.equal(loadedNodePty, false, 'the relay must not pull in node-pty');
});

test('the published file list carries the built web UI and nothing extra', () => {
  assert.ok(manifest.files.includes('web/dist'));
  assert.equal(manifest.files.includes('web/src'), false);
  assert.equal(manifest.exports['./protocol'], './src/stream-frame.js');
});

// Listing `web/dist` is not the same as shipping it. `web/dist` is gitignored,
// so on a clean checkout it does not exist, and npm drops a listed path that is
// missing rather than failing — which is how the relay was published with no
// web UI at all. `prepack` is what makes the directory exist before npm reads
// the file list.
test('the tarball is built before it is packed, so web/dist is not silently dropped', () => {
  assert.equal(manifest.scripts.prepack, 'npm run build');
  assert.equal(manifest.scripts.build, 'npm --prefix web run build');
});
