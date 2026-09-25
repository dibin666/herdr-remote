// launchd: a LaunchAgent that runs `herdr-remote run` and keeps it alive.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from 'herdr-remote-relay/state';
import { logPath, stateDir } from '../paths.js';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

export const LAUNCHD_LABEL = 'dev.herdr.remote';

export function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderLaunchdPlist({
  nodePath = process.execPath,
  entryPoint = cliEntryPoint(),
  label = LAUNCHD_LABEL,
  outLog = logPath('supervisor'),
  errLog = logPath('supervisor'),
  environment = {},
}: {
  nodePath?: string;
  entryPoint?: string;
  label?: string;
  outLog?: string;
  errLog?: string;
  environment?: Record<string, string>;
} = {}): string {
  const environmentEntries = Object.entries(environment)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
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

function domainTarget(): string {
  return `gui/${process.getuid ? process.getuid() : ''}`;
}

function serviceTarget(): string {
  return `${domainTarget()}/${LAUNCHD_LABEL}`;
}

function launchctl(args: string[]) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

/** A launchctl call whose outcome does not matter (bootout of nothing, say). */
function launchctlQuietly(args: string[]): void {
  spawnSync('launchctl', args, { stdio: 'ignore' });
}

export const launchd: KeepaliveBackend = {
  name: 'launchd',

  status(): KeepaliveStatus {
    const plistPath = launchdPlistPath();
    if (!fs.existsSync(plistPath))
      return { manager: 'launchd', installed: false, active: false, enabled: false };
    const result = launchctl(['print', serviceTarget()]);
    const output = String(result.stdout || '');
    return {
      manager: 'launchd',
      installed: true,
      active: result.status === 0 && /state = running/.test(output),
      enabled: result.status === 0,
      unitPath: plistPath,
      state: result.status === 0 ? 'loaded' : 'not loaded',
    };
  },

  install() {
    const plistPath = launchdPlistPath();
    ensureDir(path.dirname(plistPath));
    ensureDir(stateDir());
    fs.writeFileSync(plistPath, renderLaunchdPlist({ environment: serviceEnvironment() }), {
      mode: 0o644,
    });
    // bootout first so a re-install picks up the rewritten plist.
    launchctlQuietly(['bootout', serviceTarget()]);
    const result = launchctl(['bootstrap', domainTarget(), plistPath]);
    if (result.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${String(result.stderr || '').trim()}`);
    }
    launchctlQuietly(['enable', serviceTarget()]);
    return { ok: true, unitPath: plistPath };
  },

  uninstall() {
    const plistPath = launchdPlistPath();
    launchctlQuietly(['bootout', serviceTarget()]);
    fs.rmSync(plistPath, { force: true });
    return { ok: true, unitPath: plistPath };
  },

  restart() {
    launchctlQuietly(['kickstart', '-k', serviceTarget()]);
    return { ok: true };
  },

  stop() {
    launchctlQuietly(['bootout', serviceTarget()]);
  },

  // The plist sends the supervisor's output to its log file.
  logsHint() {
    return `tail -f ${logPath('supervisor')}`;
  },
};
