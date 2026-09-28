// The fallback where no service manager is usable: a detached copy of our own
// supervisor, tracked by a pid file. It does not survive a reboot.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { processStart, stillRunning } from '../lib/process.js';
import { logPath, stateDir } from '../paths.js';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

function fallbackPidPath(): string {
  return path.join(stateDir(), 'supervisor.pid');
}

/**
 * The supervisor the pid file names, if it is still that process. The file
 * outlives a reboot; its pid alone would then name something unrelated.
 */
function runningPid(): number | null {
  const record = readJson<{ pid?: unknown; processStart?: unknown }>(fallbackPidPath(), {});
  return stillRunning([record]).length > 0 ? (record.pid as number) : null;
}

function start() {
  const running = runningPid();
  if (running !== null) return { ok: true as const, alreadyRunning: true, pid: running };
  ensureDir(stateDir());
  const logFd = fs.openSync(logPath('supervisor'), 'a');
  try {
    const child = spawn(process.execPath, [cliEntryPoint(), 'run', '--daemon'], {
      // Not PACKAGE_ROOT: npm renames it to update, which Windows refuses for a working directory.
      cwd: stateDir(),
      env: { ...process.env, HERDR_REMOTE_SERVICE: '1', ...serviceEnvironment() },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    writeJsonAtomic(fallbackPidPath(), {
      pid: child.pid,
      processStart: child.pid ? processStart(child.pid) : null,
      startedAt: new Date().toISOString(),
    });
    return { ok: true as const, pid: child.pid, note: 'this fallback does not survive a reboot' };
  } finally {
    fs.closeSync(logFd);
  }
}

function stopAndForget() {
  const pid = runningPid();
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Exited between the check and the signal.
    }
  }
  fs.rmSync(fallbackPidPath(), { force: true });
  return { ok: true as const, stoppedPid: pid };
}

export function detachedLogsHint(
  platform = process.platform,
  logFile = logPath('supervisor'),
): string {
  if (platform === 'win32') return `Get-Content -Wait -Tail 40 "${logFile}"`;
  return `tail -f ${logFile}`;
}

export const detached: KeepaliveBackend = {
  name: 'supervisor',

  status(): KeepaliveStatus {
    const pid = runningPid();
    const alive = pid !== null;
    return {
      manager: 'supervisor',
      installed: alive,
      active: alive,
      enabled: false,
      pid: alive ? pid : null,
      unitPath: fallbackPidPath(),
      state: alive ? 'running' : 'stopped',
    };
  },

  async install() {
    return start();
  },

  async uninstall() {
    return stopAndForget();
  },

  restart() {
    stopAndForget();
    return start();
  },

  stop() {
    stopAndForget();
  },

  logsHint() {
    return detachedLogsHint();
  },
};
