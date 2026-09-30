// Self-update for the installed CLI.
//
// Releases come from GitHub first and npm second: a GitHub Release installs the
// moment it exists, while npm can take many minutes after publishing before a
// version resolves. Both carry the same self-contained tarball, which bundles
// the relay, so one install updates both.
//
// The update path is only meaningful for a package installed with npm. A
// source checkout is managed by git and a linked development copy by the
// developer, so this refuses to touch either: silently running `npm install -g`
// over a checkout would replace the tree someone is working in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cliTarballUrl,
  GITHUB_RELEASES_URL,
  LATEST_CLI_TARBALL_URL,
  LATEST_RELEASE_MANIFEST_URL,
} from 'herdr-remote-relay/protocol';
import { PACKAGE_ROOT } from './paths.js';
import { heldByAnotherProcess, installInPlace } from './updater/in-place.js';
import { runNpm, type NpmRun, type SpawnLike } from './updater/npm.js';

const PACKAGE_NAME = 'herdr-remote';
const RELAY_PACKAGE = 'herdr-remote-relay';
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

type InstallKind = 'npm' | 'linked' | 'source';

type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

/** What `checkForUpdate` answered. */
export interface UpdateCheck {
  ok: boolean;
  current: string;
  latest?: string;
  /** The preferred source that carries `latest`: GitHub Releases or an npm registry. */
  source?: string;
  /** Every source that carries `latest`, preferred first. */
  sources?: string[];
  /** Sources still on an older release. */
  behind?: { source: string; version?: string }[];
  updateAvailable?: boolean;
  errorKey?: string;
  message?: string;
}

/** What `performUpdate` did. */
interface UpdateResult {
  ok: boolean;
  errorKey?: string;
  installed?: string | null;
  output?: string;
  summary?: string;
}

function currentVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** The relay bundled with this herdr-remote, read from disk: an update replaces it. */
function installedRelayVersion(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve(`${RELAY_PACKAGE}/package.json`);
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * How this copy got here.
 *
 * - `npm`      installed with npm, from a release tarball or a registry; updating is `npm install -g`.
 * - `linked`   `npm link`ed into a global tree from a working copy.
 * - `source`   run straight out of a checkout.
 *
 * The distinction is drawn from the path rather than from npm, which would
 * mean shelling out on every render.
 */
function installKind(): InstallKind {
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
function updateChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_REMOTE_UPDATE_CHECK !== '0';
}

function canSelfUpdate(): boolean {
  return installKind() === 'npm';
}

function normalizeRegistry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** The `registry=` line from an npmrc file, if it has one. */
function registryFromNpmrc(filePath: string): string | null {
  let contents: string;
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
function registryCandidates({
  env = process.env,
  home = os.homedir(),
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
} = {}): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
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
function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
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
async function fetchJson(
  url: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
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
    const failure = error as Error | undefined;
    return {
      ok: false,
      message: failure?.name === 'AbortError' ? 'timed out' : String(failure?.message || error),
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
async function askRegistry(
  registry: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; latest: string } | { ok: false; message: string | null }> {
  type Body = { latest?: unknown; version?: unknown } | null | undefined;
  const endpoints = [
    {
      url: `${registry}/-/package/${PACKAGE_NAME}/dist-tags`,
      read: (body: unknown) => (body as Body)?.latest,
    },
    { url: `${registry}/${PACKAGE_NAME}/latest`, read: (body: unknown) => (body as Body)?.version },
  ];
  let message: string | null = null;
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

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The newest GitHub Release, from the manifest every release carries. */
async function askGithubReleases(
  manifestUrl: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; latest: string } | { ok: false; message: string | null }> {
  const attempt = await fetchJson(manifestUrl, { timeoutMs, fetchImpl });
  if (!attempt.ok) return attempt;
  const version = (attempt.body as { version?: unknown } | null)?.version;
  if (typeof version === 'string' && VERSION_PATTERN.test(version)) {
    return { ok: true, latest: version };
  }
  return { ok: false, message: 'release manifest has no version' };
}

/**
 * Ask what the current release is.
 *
 * Never throws: an update check is a convenience, and a machine that is offline
 * or behind a proxy should still get a working settings screen.
 *
 * GitHub Releases and every registry are asked at once and the newest answer
 * wins. Taking the first answer let a mirror a few minutes (or hours) behind
 * report the release before last as current. `sources` lists the ones that
 * already carry the newest version, GitHub first, which is where an install
 * should come from; `behind` lists the ones that do not, so the screen can say
 * why. GitHub is not reachable from every network, which is what the
 * registries are still asked for.
 */
async function checkForUpdate({
  timeoutMs = 6000,
  fetchImpl = globalThis.fetch,
  registries = registryCandidates(),
  releaseManifest = LATEST_RELEASE_MANIFEST_URL as string | null,
  current = currentVersion(),
}: {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  registries?: string[];
  /** Null leaves GitHub out, for a registry-only check. */
  releaseManifest?: string | null;
  current?: string;
} = {}): Promise<UpdateCheck> {
  const attempts = await Promise.all([
    ...(releaseManifest
      ? [
          askGithubReleases(releaseManifest, { timeoutMs, fetchImpl }).then((answer) => ({
            source: GITHUB_RELEASES_URL,
            ...answer,
          })),
        ]
      : []),
    ...registries.map(async (registry) => ({
      source: registry,
      ...(await askRegistry(registry, { timeoutMs, fetchImpl })),
    })),
  ]);
  const answers = attempts.filter(
    (attempt): attempt is { source: string; ok: true; latest: string } => attempt.ok,
  );

  if (answers.length === 0) {
    // The reason is carried out with the failure. "Could not reach npm
    // registry" with nothing after it leaves the user guessing between DNS, a
    // proxy, a firewall and a mirror that does not carry the package.
    return {
      ok: false,
      current,
      errorKey: 'update.errorNetwork',
      message: attempts
        .map((attempt) => `${attempt.source}: ${'message' in attempt ? attempt.message : ''}`)
        .join('; '),
    };
  }

  const latest = answers
    .map((answer) => answer.latest)
    .reduce((best, version) => (compareVersions(version, best) > 0 ? version : best));
  const sources = answers
    .filter((answer) => compareVersions(answer.latest, latest) === 0)
    .map((answer) => answer.source);
  const behind = answers
    .filter((answer) => compareVersions(answer.latest, latest) < 0)
    .map((answer) => ({ source: answer.source, version: answer.latest }));

  return {
    ok: true,
    current,
    latest,
    source: sources[0],
    sources,
    behind,
    updateAvailable: compareVersions(latest, current) > 0,
  };
}

/** Just the lines npm meant for a person: its `npm error` / `npm ERR!` summary. */
function npmErrorSummary(output: unknown): string {
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
function isNotYetPublished(output: unknown): boolean {
  return /\bETARGET\b|notarget|No matching version found/i.test(String(output || ''));
}

/** What is actually installed now, read from disk rather than the require cache. */
function installedVersionOnDisk(): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Install a release over this one.
 *
 * Resolves with `{ ok, output }` rather than rejecting, so the caller can show
 * npm's own message; npm's diagnostics are more useful than anything that could
 * be invented here.
 *
 * - The exact version the check found is installed, not `@latest`, from the
 *   sources that reported it: GitHub's release tarball first, then registries,
 *   asked with `--prefer-online` so npm revalidates the package metadata it
 *   cached before the release existed.
 * - Right after a release, npm's view of the package can still lack the new
 *   version although its dist-tag already points at it: npm answers ETARGET.
 *   That is a wait, not a failure, so it is retried a few times, then the next
 *   source that carries the version is tried.
 * - On Windows, when something holds the package directory so npm cannot
 *   rename it, the release is copied over it instead.
 * - Success is what is on disk afterwards, not npm's exit code.
 */
async function performUpdate({
  spawnImpl = spawn,
  timeoutMs = 180_000,
  // Seam for tests: the suite runs from a checkout, where the guard below is
  // correctly the only reachable outcome.
  installKindImpl = installKind,
  // The sources that reported `version`, preferred first. Empty means GitHub,
  // then whatever registry npm is configured with, which is right when no
  // check has run.
  source = '',
  sources = [],
  version = null,
  attempts = 3,
  retryDelayMs = 15_000,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  readInstalledVersion = installedVersionOnDisk,
  onAttempt = () => {},
  platform = process.platform,
  inPlace = installInPlace,
}: {
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
  installKindImpl?: () => InstallKind;
  source?: string;
  sources?: string[];
  version?: string | null;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  readInstalledVersion?: () => string | null;
  onAttempt?: (progress: { source: string; attempt: number }) => void;
  platform?: NodeJS.Platform;
  inPlace?: (args: string[], run: (args: string[]) => Promise<NpmRun>) => Promise<NpmRun>;
} = {}): Promise<UpdateResult> {
  const kind = installKindImpl();
  if (kind !== 'npm') return { ok: false, errorKey: `update.cannot.${kind}` };

  const target = typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null;
  const candidates: string[] = [];
  for (const candidate of [source, ...sources]) {
    const normalized = normalizeRegistry(candidate);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  }
  // '' is npm's own configured registry.
  if (candidates.length === 0) candidates.push(GITHUB_RELEASES_URL, '');

  let last: NpmRun = { ok: false, output: '' };
  let notYetPublished = false;
  for (const candidate of candidates) {
    const github = candidate === GITHUB_RELEASES_URL;
    const args = github
      ? ['install', '-g', target ? cliTarballUrl(target) : LATEST_CLI_TARBALL_URL]
      : ['install', '-g', `${PACKAGE_NAME}@${target || 'latest'}`, '--prefer-online'];
    if (candidate && !github) args.push('--registry', candidate);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      onAttempt({ source: candidate, attempt });
      let result = await runNpm(spawnImpl, args, timeoutMs);
      if (!result.ok && platform === 'win32' && heldByAnotherProcess(result.output))
        result = await inPlace(args, (stagedArgs) => runNpm(spawnImpl, stagedArgs, timeoutMs));
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
      if (!notYetPublished) break; // Not a wait: this source will not do better.
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
  DEFAULT_REGISTRY,
  MIRROR_REGISTRY,
  canSelfUpdate,
  checkForUpdate,
  compareVersions,
  currentVersion,
  installKind,
  installedVersionOnDisk,
  installedRelayVersion,
  performUpdate,
  registryCandidates,
  updateChecksEnabled,
};
