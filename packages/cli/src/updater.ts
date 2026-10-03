// Self-update for the installed CLI.
//
// GitHub Releases is the channel: a release is downloadable the moment it is
// published, and its tarball carries all of herdr-remote's JavaScript, the
// relay included, so installing it is a download and a directory swap
// (updater/release-install.ts) rather than an npm run. npm is the fallback,
// for a release whose native dependencies changed and for networks where
// GitHub cannot be reached; only then are npm registries asked at all.
//
// The update path is only meaningful for a package installed with npm. A
// source checkout is managed by git and a linked development copy by the
// developer, so this refuses to touch either: replacing the tree someone is
// working in is not an update.

import fs from 'node:fs';
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
import { installRelease, type ReleaseInstall } from './updater/release-install.js';
import {
  askGithubReleases,
  askRegistry,
  DEFAULT_REGISTRY,
  type FetchLike,
  MIRROR_REGISTRY,
  normalizeRegistry,
  registryCandidates,
  VERSION_PATTERN,
} from './updater/sources.js';

const PACKAGE_NAME = 'herdr-remote';
const RELAY_PACKAGE = 'herdr-remote-relay';

type InstallKind = 'npm' | 'linked' | 'source';

/** What `checkForUpdate` answered. */
export interface UpdateCheck {
  ok: boolean;
  current: string;
  latest?: string;
  /** Where `latest` was found: GitHub Releases, or the npm registry that answered for it. */
  source?: string;
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

/**
 * Ask what the current release is.
 *
 * Never throws: an update check is a convenience, and a machine that is offline
 * or behind a proxy should still get a working settings screen.
 *
 * GitHub Releases answers first and, when it answers, alone. The registries are
 * asked only where GitHub cannot be reached, all at once, and the newest answer
 * among them wins: a mirror hours behind must not report the release before
 * last as current.
 */
async function checkForUpdate({
  timeoutMs = 6000,
  fetchImpl = globalThis.fetch,
  registries,
  releaseManifest = LATEST_RELEASE_MANIFEST_URL as string | null,
  current = currentVersion(),
}: {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Defaults to `registryCandidates()`, read only when GitHub fails. */
  registries?: string[];
  /** Null leaves GitHub out, for a registry-only check. */
  releaseManifest?: string | null;
  current?: string;
} = {}): Promise<UpdateCheck> {
  const found = (latest: string, source: string): UpdateCheck => ({
    ok: true,
    current,
    latest,
    source,
    updateAvailable: compareVersions(latest, current) > 0,
  });
  const failures: string[] = [];
  if (releaseManifest) {
    const answer = await askGithubReleases(releaseManifest, { timeoutMs, fetchImpl });
    if (answer.ok) return found(answer.latest, GITHUB_RELEASES_URL);
    failures.push(`${GITHUB_RELEASES_URL}: ${answer.message ?? ''}`);
  }

  const attempts = await Promise.all(
    (registries ?? registryCandidates()).map(async (registry) => ({
      source: registry,
      ...(await askRegistry(registry, { timeoutMs, fetchImpl })),
    })),
  );
  let best: { source: string; latest: string } | null = null;
  for (const attempt of attempts) {
    if (!attempt.ok) failures.push(`${attempt.source}: ${attempt.message ?? ''}`);
    else if (!best || compareVersions(attempt.latest, best.latest) > 0) best = attempt;
  }
  if (best) return found(best.latest, best.source);
  // The reason is carried out with the failure. "Could not reach GitHub"
  // with nothing after it leaves the user guessing between DNS, a proxy, a
  // firewall and a mirror that does not carry the package.
  return { ok: false, current, errorKey: 'update.errorNetwork', message: failures.join('; ') };
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

/** Success is what is on disk afterwards, not what the installer said. */
function verifiedInstall(
  target: string | null,
  output: string,
  readInstalledVersion: () => string | null,
): UpdateResult {
  const installed = readInstalledVersion();
  if (target && installed && compareVersions(installed, target) < 0) {
    return {
      ok: false,
      errorKey: 'update.errorNotApplied',
      installed,
      output: output.slice(-2000),
    };
  }
  return { ok: true, installed, output: output.slice(-2000) };
}

/**
 * Install a release over this one.
 *
 * Resolves with `{ ok, output }` rather than rejecting, so the caller can show
 * the installer's own message.
 *
 * - A release found on GitHub is downloaded and swapped in without npm. Only
 *   when it needs dependencies this install lacks does npm install that same
 *   tarball; when GitHub fails mid-download, npm's registry is the fallback.
 * - A release found on a registry (GitHub unreachable) is installed by npm
 *   from that registry: the exact version found, with `--prefer-online` so npm
 *   revalidates the package metadata it cached before the release existed.
 * - Right after a release npm can still lack the version its dist-tag names
 *   and answer ETARGET. That is a wait, not a failure: it is retried a few
 *   times, then the next source is tried.
 * - On Windows, when something holds the package directory so npm cannot
 *   rename it, the release is copied over it instead.
 */
async function performUpdate({
  spawnImpl = spawn,
  timeoutMs = 180_000,
  // Seam for tests: the suite runs from a checkout, where the guard below is
  // correctly the only reachable outcome.
  installKindImpl = installKind,
  // Where the check found `version`; empty means GitHub, right when no check ran.
  source = '',
  version = null,
  attempts = 3,
  retryDelayMs = 15_000,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  readInstalledVersion = installedVersionOnDisk,
  onAttempt = () => {},
  platform = process.platform,
  inPlace = installInPlace,
  installReleaseImpl = installRelease,
}: {
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
  installKindImpl?: () => InstallKind;
  source?: string;
  version?: string | null;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  readInstalledVersion?: () => string | null;
  onAttempt?: (progress: { source: string; attempt: number }) => void;
  platform?: NodeJS.Platform;
  inPlace?: (args: string[], run: (args: string[]) => Promise<NpmRun>) => Promise<NpmRun>;
  installReleaseImpl?: (options: {
    url: string;
    version: string | null;
    platform: NodeJS.Platform;
  }) => Promise<ReleaseInstall>;
} = {}): Promise<UpdateResult> {
  const kind = installKindImpl();
  if (kind !== 'npm') return { ok: false, errorKey: `update.cannot.${kind}` };

  const target = typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null;
  const registry = normalizeRegistry(source);
  // '' is npm's own configured registry.
  let npmSources: string[];
  // Why GitHub did not do, kept for when npm does not either.
  let releaseOutput = '';
  if (!registry || registry === GITHUB_RELEASES_URL) {
    onAttempt({ source: GITHUB_RELEASES_URL, attempt: 1 });
    const url = target ? cliTarballUrl(target) : LATEST_CLI_TARBALL_URL;
    const release = await installReleaseImpl({ url, version: target, platform });
    if (release.ok) return verifiedInstall(target, release.output, readInstalledVersion);
    npmSources = release.needsNpm ? [GITHUB_RELEASES_URL, ''] : [''];
    releaseOutput = `${url}: ${release.output}\n`;
  } else {
    npmSources = [registry];
  }

  let last: NpmRun = { ok: false, output: '' };
  let notYetPublished = false;
  for (const candidate of npmSources) {
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
      if (result.ok) return verifiedInstall(target, result.output, readInstalledVersion);
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
    output: `${releaseOutput}${String(last.output || '')}`.slice(-2000),
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
