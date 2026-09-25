// Self-update for the npm-installed CLI.
//
// The update path is only meaningful for a package installed from npm. A source
// checkout is managed by git and a linked development copy by the developer, so
// this refuses to touch either: silently running `npm install -g` over a
// checkout would replace the tree someone is working in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT } from './paths.js';

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
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
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

/** `HERDR_REMOTE_UPDATE_CHECK=0` turns the automatic checks off (offline machines, tests). */
function updateChecksEnabled(env = process.env) {
  return env.HERDR_REMOTE_UPDATE_CHECK !== '0';
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
  const parse = (value) =>
    String(value)
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

/** One JSON request with a deadline. Never throws. */
async function fetchJson(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status ?? '?'}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      message: error?.name === 'AbortError' ? 'timed out' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One registry, one question: what is the latest published version?
 *
 * The dist-tags endpoint first: a few bytes, answered fresh by npmjs and
 * npmmirror alike. `/<package>/latest` is the fallback for registries without
 * it, asked for plain JSON. It used to be asked for npm's abbreviated install
 * format, which npmjs refuses on that path with a 406, so every check quietly
 * fell through to a mirror that had not synced the release yet.
 */
async function askRegistry(registry, { timeoutMs, fetchImpl }) {
  const endpoints = [
    { url: `${registry}/-/package/${PACKAGE_NAME}/dist-tags`, read: (body) => body?.latest },
    { url: `${registry}/${PACKAGE_NAME}/latest`, read: (body) => body?.version },
  ];
  let message = null;
  for (const endpoint of endpoints) {
    const attempt = await fetchJson(endpoint.url, { timeoutMs, fetchImpl });
    if (!attempt.ok) {
      message = attempt.message;
      continue;
    }
    const latest = endpoint.read(attempt.body);
    if (typeof latest === 'string' && latest) return { ok: true, latest };
    message = 'registry answered without a version';
  }
  return { ok: false, message };
}

/**
 * Ask what the current release is.
 *
 * Never throws: an update check is a convenience, and a machine that is offline
 * or behind a proxy should still get a working settings screen.
 *
 * Every registry is asked at once and the newest answer wins. Taking the first
 * answer let a mirror a few minutes (or hours) behind report the release before
 * last as current. `sources` lists the registries that already carry the
 * newest version, preferred order first, which is where an install should come
 * from; `behind` lists the ones that do not, so the screen can say why.
 */
async function checkForUpdate({
  timeoutMs = 6000,
  fetchImpl = globalThis.fetch,
  registries = registryCandidates(),
} = {}) {
  const current = currentVersion();
  const attempts = await Promise.all(
    registries.map(async (registry) => ({
      registry,
      ...(await askRegistry(registry, { timeoutMs, fetchImpl })),
    })),
  );
  const answers = attempts.filter((attempt) => attempt.ok);

  if (answers.length === 0) {
    // The reason is carried out with the failure. "Could not reach npm
    // registry" with nothing after it leaves the user guessing between DNS, a
    // proxy, a firewall and a mirror that does not carry the package.
    return {
      ok: false,
      current,
      errorKey: 'update.errorNetwork',
      message: attempts.map((attempt) => `${attempt.registry}: ${attempt.message}`).join('; '),
      triedRegistries: registries,
    };
  }

  const latest = answers
    .map((answer) => answer.latest)
    .reduce((best, version) => (compareVersions(version, best) > 0 ? version : best));
  const sources = answers
    .filter((answer) => compareVersions(answer.latest, latest) === 0)
    .map((answer) => answer.registry);
  const behind = answers
    .filter((answer) => compareVersions(answer.latest, latest) < 0)
    .map((answer) => ({ registry: answer.registry, version: answer.latest }));

  return {
    ok: true,
    current,
    latest,
    registry: sources[0],
    sources,
    behind,
    updateAvailable: compareVersions(latest, current) > 0,
  };
}

/** Just the lines npm meant for a person: its `npm error` / `npm ERR!` summary. */
function npmErrorSummary(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^npm (error|ERR!)/.test(line) && !/complete log of this run/i.test(line))
    .map((line) => line.replace(/^npm (error|ERR!)\s*/, ''))
    .filter(Boolean);
  return (
    lines.length > 0
      ? lines.slice(0, 3)
      : String(output || '')
          .trim()
          .split(/\r?\n/)
          .slice(-3)
  ).join(' ');
}

/** "No matching version": the registry has not caught up with its own dist-tag. */
function isNotYetPublished(output) {
  return /\bETARGET\b|notarget|No matching version found/i.test(String(output || ''));
}

/** What is actually installed now, read from disk rather than the require cache. */
function installedVersionOnDisk() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function runNpm(spawnImpl, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('npm', args, { timeout: timeoutMs });
    } catch (error) {
      resolve({ ok: false, spawnFailed: true, output: String(error?.message || error) });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const collect = (chunk) => {
      output += String(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => finish({ ok: false, spawnFailed: true, output: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, output: output.trim() }));
  });
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Install a release over this one.
 *
 * Resolves with `{ ok, output }` rather than rejecting, so the caller can show
 * npm's own message; npm's diagnostics are more useful than anything that could
 * be invented here.
 *
 * - The exact version the check found is installed, not `@latest`, from a
 *   registry that reported it, with `--prefer-online` so npm revalidates the
 *   package metadata it cached before the release existed.
 * - Right after a release, npm's view of the package can still lack the new
 *   version although its dist-tag already points at it: npm answers ETARGET.
 *   That is a wait, not a failure, so it is retried a few times, then the next
 *   registry that carries the version is tried.
 * - Success is what is on disk afterwards, not npm's exit code.
 *
 * @param {{
 *   spawnImpl?: Function,
 *   timeoutMs?: number,
 *   installKindImpl?: () => string,
 *   registry?: string,
 *   sources?: string[],
 *   version?: string | null,
 *   attempts?: number,
 *   retryDelayMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   readInstalledVersion?: () => string | null,
 *   onAttempt?: (progress: { registry: string, attempt: number }) => void,
 * }} [options]
 * @returns {Promise<{ ok: boolean, errorKey?: string, installed?: string | null, output?: string, summary?: string }>}
 */
async function performUpdate({
  spawnImpl = spawn,
  timeoutMs = 180_000,
  // Seam for tests: the suite runs from a checkout, where the guard below is
  // correctly the only reachable outcome.
  installKindImpl = installKind,
  // The registries that reported `version`, preferred first. Empty means
  // "whatever npm is configured with", which is right when no check has run.
  registry = '',
  sources = [],
  version = null,
  attempts = 3,
  retryDelayMs = 15_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readInstalledVersion = installedVersionOnDisk,
  onAttempt = () => {},
} = {}) {
  const kind = installKindImpl();
  if (kind !== 'npm') return { ok: false, errorKey: `update.cannot.${kind}` };

  const target = typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null;
  const spec = `${PACKAGE_NAME}@${target || 'latest'}`;
  const registries = [];
  for (const candidate of [registry, ...sources]) {
    const normalized = normalizeRegistry(candidate);
    if (normalized && !registries.includes(normalized)) registries.push(normalized);
  }
  if (registries.length === 0) registries.push('');

  let last = { output: '' };
  let notYetPublished = false;
  for (const source of registries) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      onAttempt({ registry: source, attempt });
      const args = ['install', '-g', spec, '--prefer-online'];
      if (source) args.push('--registry', source);
      const result = await runNpm(spawnImpl, args, timeoutMs);
      if (result.ok) {
        const installed = readInstalledVersion();
        if (target && installed && compareVersions(installed, target) < 0) {
          return {
            ok: false,
            errorKey: 'update.errorNotApplied',
            installed,
            output: result.output.slice(-2000),
          };
        }
        return { ok: true, installed, output: result.output.slice(-2000) };
      }
      last = result;
      if (result.spawnFailed) {
        return {
          ok: false,
          errorKey: 'update.errorFailed',
          output: result.output,
          summary: result.output,
        };
      }
      notYetPublished = isNotYetPublished(result.output);
      if (!notYetPublished) break; // Not a wait: this registry will not do better.
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  return {
    ok: false,
    errorKey: notYetPublished ? 'update.errorNotYetPublished' : 'update.errorFailed',
    output: String(last.output || '').slice(-2000),
    summary: npmErrorSummary(last.output),
  };
}

export {
  PACKAGE_NAME,
  DEFAULT_REGISTRY,
  MIRROR_REGISTRY,
  canSelfUpdate,
  checkForUpdate,
  compareVersions,
  currentVersion,
  installKind,
  installedVersionOnDisk,
  npmErrorSummary,
  performUpdate,
  registryCandidates,
  updateChecksEnabled,
};
