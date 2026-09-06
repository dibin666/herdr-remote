'use strict';

// Self-update for the npm-installed CLI.
//
// The update path is only meaningful for a package installed from npm. A source
// checkout is managed by git and a linked development copy by the developer, so
// this refuses to touch either: silently running `npm install -g` over a
// checkout would replace the tree someone is working in.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PACKAGE_ROOT } = require('./config');

const PACKAGE_NAME = 'herdr-remote';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

function currentVersion() {
  try {
    return require(path.join(PACKAGE_ROOT, 'package.json')).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * How this copy got here.
 *
 * - `npm`      installed from the registry; updating is `npm install -g`.
 * - `linked`   `npm link`ed into a global tree from a working copy.
 * - `source`   run straight out of a checkout.
 *
 * The distinction is drawn from the path rather than from npm, which would
 * mean shelling out on every render.
 */
function installKind() {
  const root = PACKAGE_ROOT;
  // A real install always lives inside a node_modules tree.
  if (!root.split(path.sep).includes('node_modules')) return 'source';
  try {
    // `npm link` leaves a symlink where a published install has a directory.
    if (fs.lstatSync(root).isSymbolicLink()) return 'linked';
  } catch {
    // Unreadable: treat as a normal install and let npm report the problem.
  }
  return 'npm';
}

function canSelfUpdate() {
  return installKind() === 'npm';
}

/** Compare two `MAJOR.MINOR.PATCH` strings. Returns 1, -1 or 0. */
function compareVersions(a, b) {
  const parse = (value) => String(value)
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

/**
 * Ask the registry what the current release is.
 *
 * Never throws: an update check is a convenience, and a machine that is offline
 * or behind a proxy should still get a working settings screen.
 */
async function checkForUpdate({ timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const current = currentVersion();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) {
      return { ok: false, current, errorKey: 'update.errorNetwork' };
    }
    const body = await response.json();
    const latest = typeof body?.version === 'string' ? body.version : null;
    if (!latest) return { ok: false, current, errorKey: 'update.errorNetwork' };
    return {
      ok: true,
      current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
    };
  } catch {
    return { ok: false, current, errorKey: 'update.errorNetwork' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install the newest release over this one.
 *
 * Resolves with `{ ok, output }` rather than rejecting, so the caller can show
 * npm's own message; npm's diagnostics are more useful than anything that could
 * be invented here.
 */
function performUpdate({
  spawnImpl = spawn,
  timeoutMs = 180_000,
  // Seam for tests: the suite runs from a checkout, where the guard below is
  // correctly the only reachable outcome.
  installKindImpl = installKind,
} = {}) {
  return new Promise((resolve) => {
    const kind = installKindImpl();
    if (kind !== 'npm') {
      resolve({ ok: false, errorKey: `update.cannot.${kind}` });
      return;
    }
    const child = spawnImpl('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    let output = '';
    const collect = (chunk) => { output += String(chunk); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      resolve({ ok: false, errorKey: 'update.errorFailed', output: error.message });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, output: output.trim().slice(-2000) });
    });
  });
}

module.exports = {
  PACKAGE_NAME,
  canSelfUpdate,
  checkForUpdate,
  compareVersions,
  currentVersion,
  installKind,
  performUpdate,
};
