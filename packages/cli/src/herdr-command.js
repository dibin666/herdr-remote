'use strict';

// How a spawned Herdr is located.
//
// `HERDR_BIN_PATH` is what the service layer hands to the host connector, and
// it is also the escape hatch for an install that is not on `PATH`. Neither is
// enough on its own once a service manager is in the picture: `systemd --user`
// and `launchd` start their units with a minimal `PATH` that contains none of
// the directories a user-level install writes to. A bare `herdr` then reaches
// `execvp(3)` inside the forked PTY child, which prints
// "execvp(3) failed.: No such file or directory" and exits — the failure the
// browser sees as an endless reconnect loop.
//
// So the name is resolved to an absolute path here, ahead of any spawn:
// an honoured override first, then `PATH`, then the handful of directories
// installers actually use.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// The same MAJOR.MINOR.PATCH comparison the self-updater uses. A second copy
// would be a second place for 0.9.10 to sort below 0.9.9.
const { compareVersions } = require('./updater');

const COMMAND_NAME = 'herdr';

/**
 * The oldest Herdr this release is written against.
 *
 * 0.9.0 gave every client its own view, which is what one PTY per browser
 * window rests on. 0.9.1 is what makes that model behave: window titles follow
 * each client's own view instead of another client's selection, activating a
 * machine in the background stops resizing somebody else's focused pane, and a
 * large paste no longer disconnects the client — and pasting is how an image
 * reaches an agent from a phone.
 */
const MIN_HERDR_VERSION = '0.9.1';

/** Where a user-level install lands, in the order we trust it. */
const FALLBACK_DIRECTORIES = [
  '~/.local/bin',
  '~/.cargo/bin',
  '~/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  '/usr/bin',
];

function expandHome(directory, home) {
  if (directory === '~') return home;
  if (directory.startsWith('~/')) return path.join(home, directory.slice(2));
  return directory;
}

/** Windows keeps the executable bit in the extension instead of the mode. */
function candidateNames(base = COMMAND_NAME) {
  return process.platform === 'win32'
    ? [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`]
    : [base];
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInDirectory(directory, names = candidateNames()) {
  if (!directory) return null;
  for (const name of names) {
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function findOnSearchPath(searchPath, names = candidateNames()) {
  for (const entry of String(searchPath || '').split(path.delimiter)) {
    const found = findInDirectory(entry.trim(), names);
    if (found) return found;
  }
  return null;
}

function fallbackDirectories(home = os.homedir()) {
  return FALLBACK_DIRECTORIES.map((directory) => expandHome(directory, home));
}

function looksLikePath(value) {
  return value.includes('/') || value.includes(path.sep);
}

/**
 * Honour `HERDR_BIN_PATH`.
 *
 * It is documented as the executable, but a directory is an easy thing to
 * write there, and a bare name — someone copying `herdr` into a unit file —
 * still has to go through the search. A value that resolves to nothing is
 * treated as absent rather than fatal: a stale override left behind by a
 * moved install is precisely the case we are trying to survive.
 */
function resolveOverride(value, searchPath) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (looksLikePath(trimmed)) {
    const absolute = path.resolve(trimmed);
    if (isExecutableFile(absolute)) return absolute;
    return findInDirectory(absolute);
  }
  return findOnSearchPath(searchPath, candidateNames(trimmed));
}

/**
 * Everything known about where Herdr is, so callers can report it and not only
 * spawn it.
 *
 * `source` is `env` for an honoured `HERDR_BIN_PATH`, `path` for a hit on
 * `PATH`, `fallback` for one of the well-known install directories, and
 * `unresolved` when nothing matched. In that last case `command` is still the
 * bare name: `PATH` may be right in a way we cannot see from here, and letting
 * the spawn proceed keeps the old behaviour for anyone relying on it.
 */
function findHerdrCommand({ env = process.env, home = os.homedir(), directories = fallbackDirectories(home) } = {}) {
  const override = resolveOverride(env.HERDR_BIN_PATH, env.PATH);
  if (override) return { command: override, source: 'env', found: true };
  const onPath = findOnSearchPath(env.PATH);
  if (onPath) return { command: onPath, source: 'path', found: true };
  for (const directory of directories) {
    const found = findInDirectory(directory);
    if (found) return { command: found, source: 'fallback', found: true };
  }
  return { command: COMMAND_NAME, source: 'unresolved', found: false };
}

function resolveHerdrCommand(options) {
  return findHerdrCommand(options).command;
}

/**
 * Re-check a command resolved earlier. A connector outlives the install that
 * was missing when it started, and an absolute path outlives the binary it
 * pointed at, so neither answer stays true for the life of the service.
 */
function verifyHerdrCommand(command, options = {}) {
  if (typeof command === 'string' && looksLikePath(command) && isExecutableFile(command)) {
    return { command, source: 'verified', found: true };
  }
  return findHerdrCommand(options);
}

/** `herdr 0.9.1`, `herdr 0.10.0-preview.2` — the three numbers are all we compare. */
function parseHerdrVersion(output) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(output || ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Whether an install is new enough.
 *
 * An unreadable version counts as new enough. Not knowing is not evidence of an
 * old Herdr, and a warning nobody can act on is worse than no warning.
 */
function meetsMinimum(version, minimum = MIN_HERDR_VERSION) {
  if (!version) return true;
  return compareVersions(version, minimum) >= 0;
}

/**
 * Ask an install what it is.
 *
 * Deliberately the binary and not the socket: `--version` answers before the
 * server is up, which is when the TUI and the plugin registration ask.
 *
 * `ok` is whether the command ran at all — the presence check registration has
 * always used. `version` is null whenever the output could not be read, and
 * `supported` is true in that case for the reason `meetsMinimum` explains.
 */
function herdrVersion({ command, timeout = 10_000, ...lookup } = {}) {
  const resolved = command || resolveHerdrCommand(lookup);
  const unknown = { command: resolved, version: null, raw: null, supported: true, ok: false };
  let result;
  try {
    result = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout });
  } catch {
    return unknown;
  }
  // Status 1 has always counted as present: a binary that answers at all is
  // installed, whatever it thinks of the flag.
  if (result.error || (result.status !== 0 && result.status !== 1)) return unknown;
  const raw = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const version = parseHerdrVersion(raw);
  return { command: resolved, version, raw: raw || null, supported: meetsMinimum(version), ok: true };
}

/** The one line that tells a user why an older Herdr is a problem here. */
function herdrOutdatedMessage(version) {
  return `Herdr ${version} is older than ${MIN_HERDR_VERSION}, which herdr-remote is written against. `
    + 'Run "herdr update" — window titles, background machine activation and large pastes all '
    + 'misbehave in browser windows before that release.';
}

/** The one message a user needs to fix a missing install themselves. */
function herdrNotFoundMessage({ env = process.env, home = os.homedir(), directories = fallbackDirectories(home) } = {}) {
  const override = String(env.HERDR_BIN_PATH || '').trim();
  const parts = [`Herdr executable "${COMMAND_NAME}" was not found.`];
  if (override) parts.push(`HERDR_BIN_PATH=${override} does not point at an executable.`);
  parts.push(directories.length ? `Searched PATH and ${directories.join(', ')}.` : 'Searched PATH.');
  parts.push('Install Herdr or set HERDR_BIN_PATH to its full path, then restart herdr-remote.');
  return parts.join(' ');
}

module.exports = {
  COMMAND_NAME,
  FALLBACK_DIRECTORIES,
  MIN_HERDR_VERSION,
  fallbackDirectories,
  findHerdrCommand,
  herdrNotFoundMessage,
  herdrOutdatedMessage,
  herdrVersion,
  meetsMinimum,
  parseHerdrVersion,
  resolveHerdrCommand,
  verifyHerdrCommand,
};
