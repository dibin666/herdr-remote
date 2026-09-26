// Keep-alive integration.
//
// "Start the services" and "keep the services running" are different problems:
// a detached spawn dies with the first crash and never comes back. This module
// hands supervision to the platform's service manager where one exists
// (systemd --user on Linux, launchd on macOS) and falls back to a detached copy
// of our own supervisor where neither does.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Config, type KeepaliveManager, loadConfig } from '../config.js';
import { detached } from './detached.js';
import { launchd } from './launchd.js';
import { systemd } from './systemd.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

export { serviceEnvironment, servicePath } from './environment.js';
export { escapeXml, renderLaunchdPlist } from './launchd.js';
export { renderSystemdUnit, systemdEnvironmentLine } from './systemd.js';
export type { KeepaliveStatus } from './types.js';

/**
 * Look for an executable on PATH without going through a shell: `spawnSync`
 * with `shell: true` concatenates rather than escapes its arguments, and Node
 * now warns about it on every call.
 */
function commandExists(command: string): boolean {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        fs.accessSync(path.join(directory, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** Which manager to use given the platform, the user's preference and reality. */
export function detectManager(
  preference: KeepaliveManager = 'auto',
): Exclude<KeepaliveManager, 'auto'> {
  if (preference && preference !== 'auto') return preference;
  if (process.platform === 'linux') {
    // `systemctl --user` needs a user bus; containers and bare TTY logins often
    // have systemd installed but no session bus, where it would fail at runtime.
    if (
      commandExists('systemctl') &&
      (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR)
    ) {
      return 'systemd';
    }
    return 'supervisor';
  }
  if (process.platform === 'darwin') {
    return commandExists('launchctl') ? 'launchd' : 'supervisor';
  }
  return 'supervisor';
}

function managerOf(config: Config) {
  return detectManager(config.keepalive?.manager || 'auto');
}

/** The backend for `config`. With keep-alive off, uninstalling still cleans up the fallback. */
function backendOf(config: Config): KeepaliveBackend {
  const manager = managerOf(config);
  if (manager === 'systemd') return systemd;
  if (manager === 'launchd') return launchd;
  return detached;
}

export function status(config = loadConfig()): KeepaliveStatus {
  if (managerOf(config) === 'none')
    return { manager: 'none', installed: false, active: false, enabled: false };
  return backendOf(config).status();
}

export function install(config = loadConfig()) {
  if (managerOf(config) === 'none') throw new Error('keep-alive is disabled in the configuration');
  const backend = backendOf(config);
  return { manager: backend.name, ...backend.install() };
}

export function uninstall(config = loadConfig()) {
  const backend = backendOf(config);
  return { manager: backend.name, ...backend.uninstall() };
}

/** Restart whatever manages the services, so config edits take effect. */
export function restart(config = loadConfig()) {
  const backend = backendOf(config);
  return { manager: backend.name, ...backend.restart() };
}

/**
 * Stop the managed services. Killing the child pids directly would only make
 * the service manager start them again, so an installed manager is asked to
 * stop instead.
 */
export function stopManaged(config = loadConfig()) {
  const current = status(config);
  if (current.manager === 'none' || (!current.installed && !current.active))
    return { managed: false };
  backendOf(config).stop();
  return { managed: true, manager: current.manager };
}

export function enableLinger(): { ok: true; username: string } {
  const username = os.userInfo().username;
  const result = spawnSync('loginctl', ['enable-linger', username], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || '').trim() || 'loginctl enable-linger failed');
  }
  return { ok: true, username };
}

export function logsHint(config = loadConfig()): string {
  return backendOf(config).logsHint();
}
