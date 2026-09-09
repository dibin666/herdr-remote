'use strict';

// Keep-alive integration.
//
// "Start the services" and "keep the services running" are different problems:
// a detached spawn dies with the first crash and never comes back. This module
// hands supervision to the platform's service manager where one exists
// (systemd --user on Linux, launchd on macOS) and falls back to a detached copy
// of our own supervisor where neither does.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PACKAGE_ROOT, loadConfig, stateDir } = require('./config');
const { ensureDir, readJson, writeJsonAtomic } = require('./state');
const { logPath, pidAlive } = require('./service');
const { findHerdrCommand } = require('./herdr-command');

const SYSTEMD_UNIT_NAME = 'herdr-remote.service';
const LAUNCHD_LABEL = 'dev.herdr.remote';
const FALLBACK_PID_FILE = 'supervisor.pid';

function cliEntryPoint() {
  return path.join(PACKAGE_ROOT, 'bin', 'herdr-remote.js');
}

function systemdUnitPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function fallbackPidPath() {
  return path.join(stateDir(), FALLBACK_PID_FILE);
}

/**
 * Look for an executable on PATH without going through a shell: `spawnSync`
 * with `shell: true` concatenates rather than escapes its arguments, and Node
 * now warns about it on every call.
 */
function commandExists(command) {
  const searchPath = process.env.PATH || '';
  return searchPath.split(path.delimiter).filter(Boolean).some((directory) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Which manager to use given the platform, the user's preference and reality. */
function detectManager(preference = 'auto') {
  if (preference && preference !== 'auto') return preference;
  if (process.platform === 'linux') {
    // `systemctl --user` needs a user bus; containers and bare TTY logins often
    // have systemd installed but no session bus, where it would fail at runtime.
    if (commandExists('systemctl') && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR)) {
      return 'systemd';
    }
    return 'supervisor';
  }
  if (process.platform === 'darwin') {
    return commandExists('launchctl') ? 'launchd' : 'supervisor';
  }
  return 'supervisor';
}

// ---------------------------------------------------------------------------
// The environment a supervised copy needs
// ---------------------------------------------------------------------------

/**
 * `PATH` for the unit: the one that is resolving commands right now, plus the
 * directory Herdr was found in.
 *
 * A service manager does not inherit the shell's environment. `systemd --user`
 * hands a unit something close to `/usr/local/bin:/usr/bin:/bin` and `launchd`
 * is no more generous, so a copy that works from a terminal loses `~/.local/bin`
 * — and with it `herdr` — the moment it is installed as a service. Freezing the
 * installing shell's `PATH` into the unit keeps the supervised copy able to find
 * Herdr, and Herdr able to find the tools it spawns in turn.
 */
function servicePath({ env = process.env, herdrCommand = null } = {}) {
  const entries = String(env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  // The override already pins the exact binary; this is only so the session
  // itself can still reach it by name.
  if (herdrCommand) entries.push(path.dirname(herdrCommand));
  const seen = new Set();
  const unique = entries.filter((entry) => (seen.has(entry) ? false : seen.add(entry)));
  return unique.join(path.delimiter);
}

/**
 * What has to be written into the unit file for a supervised start to behave
 * like the one the user just ran by hand.
 */
function serviceEnvironment({ env = process.env, home = os.homedir(), directories } = {}) {
  const environment = {};
  const herdr = findHerdrCommand({ env, home, ...(directories ? { directories } : {}) });
  if (herdr.found) environment.HERDR_BIN_PATH = herdr.command;
  const searchPath = servicePath({ env, herdrCommand: herdr.found ? herdr.command : null });
  if (searchPath) environment.PATH = searchPath;
  return environment;
}

// ---------------------------------------------------------------------------
// Unit file rendering (pure, so it can be asserted in tests)
// ---------------------------------------------------------------------------

/**
 * One `KEY=value` per directive. An unquoted systemd value ends at the first
 * space, and `%` starts a specifier, so a `PATH` with either in it would be
 * silently truncated or rewritten.
 */
function systemdEnvironmentLine(key, value) {
  const text = String(value).replace(/[\r\n]+/g, ' ').replace(/%/g, '%%');
  if (/^[\w@+=:,./-]*$/.test(text)) return `Environment=${key}=${text}`;
  return `Environment="${key}=${text.replace(/([\\"])/g, '\\$1')}"`;
}

function renderSystemdUnit({ nodePath = process.execPath, entryPoint = cliEntryPoint(), environment = {} } = {}) {
  const environmentLines = Object.entries(environment)
    .map(([key, value]) => systemdEnvironmentLine(key, value))
    .join('\n');
  return `[Unit]
Description=Herdr Remote (relay and host connector)
Documentation=https://github.com/herdr/herdr-remote
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${entryPoint} run
Restart=always
RestartSec=3
# Give the relay and host connector time to close sessions cleanly.
TimeoutStopSec=15
${environmentLines}

[Install]
WantedBy=default.target
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderLaunchdPlist({
  nodePath = process.execPath,
  entryPoint = cliEntryPoint(),
  label = LAUNCHD_LABEL,
  outLog = logPath('supervisor'),
  errLog = logPath('supervisor'),
  environment = {},
} = {}) {
  const environmentEntries = Object.entries(environment)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join('\n');
  const environmentBlock = environmentEntries
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n${environmentEntries}\n    </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(nodePath)}</string>
      <string>${escapeXml(entryPoint)}</string>
      <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${environmentBlock}    <key>StandardOutPath</key>
    <string>${escapeXml(outLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(errLog)}</string>
  </dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

function systemctl(args, { capture = true } = {}) {
  return spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
}

function systemdStatus() {
  const installed = fs.existsSync(systemdUnitPath());
  if (!installed) return { manager: 'systemd', installed: false, active: false, enabled: false };
  const active = systemctl(['is-active', SYSTEMD_UNIT_NAME]);
  const enabled = systemctl(['is-enabled', SYSTEMD_UNIT_NAME]);
  const lingering = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], { encoding: 'utf8' });
  return {
    manager: 'systemd',
    installed: true,
    active: String(active.stdout || '').trim() === 'active',
    enabled: String(enabled.stdout || '').trim().startsWith('enabled'),
    linger: String(lingering.stdout || '').includes('Linger=yes'),
    unitPath: systemdUnitPath(),
    state: String(active.stdout || active.stderr || '').trim(),
  };
}

function systemdInstall() {
  const unitPath = systemdUnitPath();
  ensureDir(path.dirname(unitPath));
  fs.writeFileSync(unitPath, renderSystemdUnit({ environment: serviceEnvironment() }), { mode: 0o644 });
  const reload = systemctl(['daemon-reload']);
  if (reload.status !== 0) {
    throw new Error(`systemctl --user daemon-reload failed: ${String(reload.stderr || '').trim()}`);
  }
  const enable = systemctl(['enable', '--now', SYSTEMD_UNIT_NAME]);
  if (enable.status !== 0) {
    throw new Error(`systemctl --user enable --now failed: ${String(enable.stderr || '').trim()}`);
  }
  return { ok: true, unitPath, hint: `loginctl enable-linger ${os.userInfo().username}` };
}

function systemdUninstall() {
  const unitPath = systemdUnitPath();
  systemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
  if (fs.existsSync(unitPath)) fs.rmSync(unitPath, { force: true });
  systemctl(['daemon-reload']);
  return { ok: true, unitPath };
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

function launchdDomainTarget() {
  return `gui/${process.getuid ? process.getuid() : ''}`;
}

function launchdStatus() {
  const plistPath = launchdPlistPath();
  const installed = fs.existsSync(plistPath);
  if (!installed) return { manager: 'launchd', installed: false, active: false, enabled: false };
  const result = spawnSync('launchctl', ['print', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { encoding: 'utf8' });
  const output = String(result.stdout || '');
  return {
    manager: 'launchd',
    installed: true,
    active: result.status === 0 && /state = running/.test(output),
    enabled: result.status === 0,
    unitPath: plistPath,
    state: result.status === 0 ? 'loaded' : 'not loaded',
  };
}

function launchdInstall() {
  const plistPath = launchdPlistPath();
  ensureDir(path.dirname(plistPath));
  ensureDir(stateDir());
  fs.writeFileSync(plistPath, renderLaunchdPlist({ environment: serviceEnvironment() }), { mode: 0o644 });
  // bootout first so a re-install picks up the rewritten plist.
  spawnSync('launchctl', ['bootout', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
  const result = spawnSync('launchctl', ['bootstrap', launchdDomainTarget(), plistPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${String(result.stderr || '').trim()}`);
  }
  spawnSync('launchctl', ['enable', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
  return { ok: true, unitPath: plistPath };
}

function launchdUninstall() {
  const plistPath = launchdPlistPath();
  spawnSync('launchctl', ['bootout', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath, { force: true });
  return { ok: true, unitPath: plistPath };
}

// ---------------------------------------------------------------------------
// Fallback supervisor daemon
// ---------------------------------------------------------------------------

function readFallbackPid() {
  const record = readJson(fallbackPidPath(), {});
  return Number.isInteger(record.pid) ? record.pid : null;
}

function fallbackStatus() {
  const pid = readFallbackPid();
  const alive = pidAlive(pid);
  return {
    manager: 'supervisor',
    installed: alive,
    active: alive,
    enabled: false,
    pid: alive ? pid : null,
    unitPath: fallbackPidPath(),
    state: alive ? 'running' : 'stopped',
  };
}

function fallbackInstall() {
  if (pidAlive(readFallbackPid())) return { ok: true, alreadyRunning: true, pid: readFallbackPid() };
  ensureDir(stateDir());
  const logFd = fs.openSync(logPath('supervisor'), 'a');
  try {
    const child = spawn(process.execPath, [cliEntryPoint(), 'run', '--daemon'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, HERDR_REMOTE_SERVICE: '1', ...serviceEnvironment() },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    writeJsonAtomic(fallbackPidPath(), { pid: child.pid, startedAt: new Date().toISOString() });
    return { ok: true, pid: child.pid, note: 'this fallback does not survive a reboot' };
  } finally {
    fs.closeSync(logFd);
  }
}

function fallbackUninstall() {
  const pid = readFallbackPid();
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  try { fs.rmSync(fallbackPidPath(), { force: true }); } catch {}
  return { ok: true, stoppedPid: pid };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function resolveManager(config = loadConfig()) {
  return detectManager(config.keepalive?.manager || 'auto');
}

function status(config = loadConfig()) {
  const manager = resolveManager(config);
  if (manager === 'none') return { manager: 'none', installed: false, active: false, enabled: false };
  if (manager === 'systemd') return systemdStatus();
  if (manager === 'launchd') return launchdStatus();
  return fallbackStatus();
}

function install(config = loadConfig()) {
  const manager = resolveManager(config);
  if (manager === 'systemd') return { manager, ...systemdInstall() };
  if (manager === 'launchd') return { manager, ...launchdInstall() };
  if (manager === 'none') throw new Error('keep-alive is disabled in the configuration');
  return { manager: 'supervisor', ...fallbackInstall() };
}

function uninstall(config = loadConfig()) {
  const manager = resolveManager(config);
  if (manager === 'systemd') return { manager, ...systemdUninstall() };
  if (manager === 'launchd') return { manager, ...launchdUninstall() };
  return { manager: 'supervisor', ...fallbackUninstall() };
}

/** Restart whatever manages the services, so config edits take effect. */
function restart(config = loadConfig()) {
  const manager = resolveManager(config);
  if (manager === 'systemd') {
    const result = systemctl(['restart', SYSTEMD_UNIT_NAME]);
    if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || 'systemctl restart failed');
    return { manager, ok: true };
  }
  if (manager === 'launchd') {
    spawnSync('launchctl', ['kickstart', '-k', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    return { manager, ok: true };
  }
  fallbackUninstall();
  return { manager: 'supervisor', ...fallbackInstall() };
}

/**
 * Stop the managed services. Killing the child pids directly would only make
 * the service manager start them again, so an installed manager is asked to
 * stop instead.
 */
function stopManaged(config = loadConfig()) {
  const current = status(config);
  if (!current.installed && !current.active) return { managed: false };
  if (current.manager === 'systemd') {
    systemctl(['stop', SYSTEMD_UNIT_NAME]);
    return { managed: true, manager: 'systemd' };
  }
  if (current.manager === 'launchd') {
    spawnSync('launchctl', ['bootout', `${launchdDomainTarget()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    return { managed: true, manager: 'launchd' };
  }
  if (current.manager === 'supervisor' && current.active) {
    fallbackUninstall();
    return { managed: true, manager: 'supervisor' };
  }
  return { managed: false };
}

function enableLinger() {
  const username = os.userInfo().username;
  const result = spawnSync('loginctl', ['enable-linger', username], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'loginctl enable-linger failed');
  }
  return { ok: true, username };
}

function logsHint(config = loadConfig()) {
  const manager = resolveManager(config);
  if (manager === 'systemd') return `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`;
  if (manager === 'launchd') return `tail -f ${logPath('supervisor')}`;
  return `tail -f ${logPath('supervisor')}`;
}

module.exports = {
  SYSTEMD_UNIT_NAME,
  LAUNCHD_LABEL,
  cliEntryPoint,
  systemdUnitPath,
  launchdPlistPath,
  fallbackPidPath,
  detectManager,
  resolveManager,
  renderSystemdUnit,
  renderLaunchdPlist,
  escapeXml,
  servicePath,
  serviceEnvironment,
  systemdEnvironmentLine,
  status,
  install,
  uninstall,
  restart,
  stopManaged,
  enableLinger,
  logsHint,
};
