// systemd --user: a unit that runs `herdr-remote run` and restarts it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from 'herdr-remote-relay/state';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

const SYSTEMD_UNIT_NAME = 'herdr-remote.service';

function systemdUnitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/**
 * One `KEY=value` per directive. An unquoted systemd value ends at the first
 * space, and `%` starts a specifier, so a `PATH` with either in it would be
 * silently truncated or rewritten.
 */
export function systemdEnvironmentLine(key: string, value: unknown): string {
  const text = String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/%/g, '%%');
  if (/^[\w@+=:,./-]*$/.test(text)) return `Environment=${key}=${text}`;
  return `Environment="${key}=${text.replace(/([\\"])/g, '\\$1')}"`;
}

export function renderSystemdUnit({
  nodePath = process.execPath,
  entryPoint = cliEntryPoint(),
  environment = {},
}: {
  nodePath?: string;
  entryPoint?: string;
  environment?: Record<string, string>;
} = {}): string {
  const environmentLines = Object.entries(environment)
    .map(([key, value]) => systemdEnvironmentLine(key, value))
    .join('\n');
  return `[Unit]
Description=Herdr Remote (relay and host connector)
Documentation=https://github.com/dibin666/herdr-remote
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

function systemctl(args: string[]) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: 'pipe' });
}

/** Run a systemctl command that must succeed, throwing its stderr when it does not. */
function systemctlOrThrow(args: string[], failure: string): void {
  const result = systemctl(args);
  if (result.status !== 0) {
    throw new Error(`${failure}: ${String(result.stderr || '').trim()}`);
  }
}

export const systemd: KeepaliveBackend = {
  name: 'systemd',

  status(): KeepaliveStatus {
    const installed = fs.existsSync(systemdUnitPath());
    if (!installed) return { manager: 'systemd', installed: false, active: false, enabled: false };
    const active = systemctl(['is-active', SYSTEMD_UNIT_NAME]);
    const enabled = systemctl(['is-enabled', SYSTEMD_UNIT_NAME]);
    const lingering = spawnSync(
      'loginctl',
      ['show-user', os.userInfo().username, '--property=Linger'],
      { encoding: 'utf8' },
    );
    return {
      manager: 'systemd',
      installed: true,
      active: String(active.stdout || '').trim() === 'active',
      enabled: String(enabled.stdout || '')
        .trim()
        .startsWith('enabled'),
      linger: String(lingering.stdout || '').includes('Linger=yes'),
      unitPath: systemdUnitPath(),
      state: String(active.stdout || active.stderr || '').trim(),
    };
  },

  install() {
    const unitPath = systemdUnitPath();
    ensureDir(path.dirname(unitPath));
    fs.writeFileSync(unitPath, renderSystemdUnit({ environment: serviceEnvironment() }), {
      mode: 0o644,
    });
    systemctlOrThrow(['daemon-reload'], 'systemctl --user daemon-reload failed');
    systemctlOrThrow(
      ['enable', '--now', SYSTEMD_UNIT_NAME],
      'systemctl --user enable --now failed',
    );
    return { ok: true, unitPath, hint: `loginctl enable-linger ${os.userInfo().username}` };
  },

  uninstall() {
    const unitPath = systemdUnitPath();
    systemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
    fs.rmSync(unitPath, { force: true });
    systemctl(['daemon-reload']);
    return { ok: true, unitPath };
  },

  restart() {
    const result = systemctl(['restart', SYSTEMD_UNIT_NAME]);
    if (result.status !== 0)
      throw new Error(String(result.stderr || '').trim() || 'systemctl restart failed');
    return { ok: true };
  },

  stop() {
    systemctl(['stop', SYSTEMD_UNIT_NAME]);
  },

  logsHint() {
    return `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f`;
  },
};
