'use strict';

// Self-update for the npm-installed CLI.
//
// The update path is only meaningful for a package installed from npm. A source
// checkout is managed by git and a linked development copy by the developer, so
// this refuses to touch either: silently running `npm install -g` over a
// checkout would replace the tree someone is working in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PACKAGE_ROOT } = require('./config');

const PACKAGE_NAME = 'herdr-remote';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * A public mirror, tried last.
 *
 * `registry.npmjs.org` is not reachable from every network this runs on — in
 * mainland China it usually is not — and "could not reach npm registry" on a
 * machine that installs packages perfectly well is a bug report, not a
 * diagnosis. The mirror is read-only and only ever asked for a version number.
 */
const MIRROR_REGISTRY = 'https://registry.npmmirror.com';

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

function normalizeRegistry(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** The `registry=` line from an npmrc file, if it has one. */
function registryFromNpmrc(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let found = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^registry\s*=\s*(.+)$/i.exec(line);
    // The last assignment wins, as it does for npm itself.
    if (match) found = normalizeRegistry(match[1].replace(/^["']|["']$/g, ''));
  }
  return found;
}

/**
 * Where to ask, in the order to ask.
 *
 * Whatever npm itself is configured to use comes first: a machine behind a
 * corporate proxy or on a mirror has already answered this question, and
 * ignoring that answer is what made the check fail on a machine where
 * `npm install` works. The public registry and then a public mirror follow, so
 * a private registry that does not carry this package is not the end of it.
 */
function registryCandidates({ env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  const candidates = [];
  const add = (value) => {
    const normalized = normalizeRegistry(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  // npm exports its whole config into the environment of anything it runs.
  add(env.npm_config_registry);
  add(env.NPM_CONFIG_REGISTRY);
  add(env.HERDR_REMOTE_REGISTRY);
  add(registryFromNpmrc(path.join(cwd, '.npmrc')));
  add(registryFromNpmrc(path.join(home, '.npmrc')));
  add(DEFAULT_REGISTRY);
  add(MIRROR_REGISTRY);
  return candidates;
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

/** One registry, one question: what is the latest published version? */
async function askRegistry(registry, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${registry}/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status ?? '?'}` };
    const body = await response.json();
    const latest = typeof body?.version === 'string' ? body.version : null;
    if (!latest) return { ok: false, message: 'registry answered without a version' };
    return { ok: true, latest };
  } catch (error) {
    return { ok: false, message: error?.name === 'AbortError' ? 'timed out' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask what the current release is.
 *
 * Never throws: an update check is a convenience, and a machine that is offline
 * or behind a proxy should still get a working settings screen. Each configured
 * registry is tried in turn, because the first one is only a guess at which
 * mirror this machine can actually reach.
 */
async function checkForUpdate({
  timeoutMs = 6000,
  fetchImpl = globalThis.fetch,
  registries = registryCandidates(),
} = {}) {
  const current = currentVersion();
  const failures = [];

  for (const registry of registries) {
    const attempt = await askRegistry(registry, { timeoutMs, fetchImpl });
    if (attempt.ok) {
      return {
        ok: true,
        current,
        latest: attempt.latest,
        registry,
        updateAvailable: compareVersions(attempt.latest, current) > 0,
      };
    }
    failures.push(`${registry}: ${attempt.message}`);
  }

  // The reason is carried out with the failure. "Could not reach npm registry"
  // with nothing after it leaves the user guessing between DNS, a proxy, a
  // firewall and a mirror that does not carry the package.
  return {
    ok: false,
    current,
    errorKey: 'update.errorNetwork',
    message: failures.join('; '),
    triedRegistries: registries,
  };
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
  // The registry that just answered the version check. Installing from
  // somewhere the machine has been shown to reach beats installing from a
  // default it may have no route to. Empty means "whatever npm is configured
  // with", which is the right answer when no check has run.
  registry = '',
} = {}) {
  return new Promise((resolve) => {
    const kind = installKindImpl();
    if (kind !== 'npm') {
      resolve({ ok: false, errorKey: `update.cannot.${kind}` });
      return;
    }
    const args = ['install', '-g', `${PACKAGE_NAME}@latest`];
    const normalizedRegistry = normalizeRegistry(registry);
    if (normalizedRegistry) args.push('--registry', normalizedRegistry);
    const child = spawnImpl('npm', args, {
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
  DEFAULT_REGISTRY,
  MIRROR_REGISTRY,
  canSelfUpdate,
  checkForUpdate,
  compareVersions,
  currentVersion,
  installKind,
  performUpdate,
  registryCandidates,
};
