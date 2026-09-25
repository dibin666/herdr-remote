// The whole point of splitting the relay into its own package is that it can be
// deployed on a server that has none of the workstation-side code: no plugin,
// no Herdr, and above all no node-pty, whose native build is the reason the old
// single-package install was slow and fragile. These tests fail the moment that
// separation is broken, because the breakage is otherwise invisible until
// someone tries to install the relay on a machine without a compiler.
// Relay test files are held to the same boundary as production code so that
// test runs never require native compilation tools.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'vitest';
import manifest from '../package.json';

const PACKAGE_ROOT = path.resolve(__dirname, '..');

/** Matches a static import, a dynamic import or a require of `specifier`. */
const importOf = (specifier) =>
  new RegExp(`(?:\\brequire\\(|\\bimport\\(|\\bfrom\\s+)['"]${specifier}['"]`);

function sourceFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(full) ? [full] : [];
  });
}

function scannedFiles() {
  return [
    ...sourceFiles(path.join(PACKAGE_ROOT, 'src')),
    ...sourceFiles(path.join(PACKAGE_ROOT, 'bin')),
    ...sourceFiles(path.join(PACKAGE_ROOT, 'tests')),
  ].filter((file) => {
    // Exclude boundary.test.js itself because its regex patterns contain the forbidden literals.
    return file !== __filename;
  });
}

test('the relay depends on nothing but ws', () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ['ws']);
  assert.equal(manifest.dependencies['node-pty'], undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test('no relay source imports the workstation package', () => {
  const forbidden = [
    importOf('herdr-remote'),
    importOf(`[^'"]*packages/cli[^'"]*`),
    importOf('node-pty'),
  ];
  const offenders = [];

  for (const file of scannedFiles()) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(contents))
        offenders.push(`${path.relative(PACKAGE_ROOT, file)} matches ${pattern}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('no relay source reaches outside the package', () => {
  // An import that climbs above the package root would resolve during local
  // development and break in the published tarball.
  const relative = importOf(`(\\.\\.?/[^'"]+)`);
  const offenders = [];
  for (const file of scannedFiles()) {
    const contents = fs.readFileSync(file, 'utf8');
    const matches = contents.match(new RegExp(relative.source, 'g')) || [];
    for (const match of matches) {
      const specifier = relative.exec(match)[1];
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(PACKAGE_ROOT + path.sep)) {
        offenders.push(`${path.relative(PACKAGE_ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the relay loads and serves without any workstation module present', () => {
  // Requiring the published entry points is the cheapest proof that the
  // dependency graph really is self-contained. `pretest` builds dist/.
  const require = createRequire(__filename);
  const { RelayServer } = require('../dist/relay-server');
  const { loadRelayConfig } = require('../dist/relay-config');
  assert.equal(typeof RelayServer, 'function');
  assert.equal(typeof loadRelayConfig, 'function');
  assert.equal(require.cache[require.resolve('../dist/relay-server')] !== undefined, true);

  const loadedNodePty = Object.keys(require.cache).some((key) =>
    key.includes(`${path.sep}node-pty${path.sep}`),
  );
  assert.equal(loadedNodePty, false, 'the relay must not pull in node-pty');
});

test('the published file list carries the built server and web UI and nothing extra', () => {
  assert.ok(manifest.files.includes('dist'));
  assert.ok(manifest.files.includes('web/dist'));
  assert.equal(manifest.files.includes('src'), false);
  assert.equal(manifest.files.includes('web/src'), false);
  assert.equal(manifest.exports['./protocol'].default, './dist/stream-frame.js');
});

// Listing `dist` and `web/dist` is not the same as shipping them. Both are
// gitignored, so on a clean checkout they do not exist, and npm drops a listed
// path that is missing rather than failing — which is how the relay was once
// published with no web UI at all. `prepack` is what makes both directories
// exist before npm reads the file list.
test('the tarball is built before it is packed, so dist and web/dist are not silently dropped', () => {
  assert.equal(manifest.scripts.prepack, 'npm run build');
  assert.match(manifest.scripts.build, /npm run build:server/);
  assert.match(manifest.scripts.build, /npm --prefix web run build/);
  assert.match(manifest.scripts['build:server'], /tsc -p tsconfig\.json/);
});
