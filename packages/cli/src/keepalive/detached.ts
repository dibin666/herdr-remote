// The fallback where no service manager is usable: a detached copy of our own
// supervisor, tracked by a pid file. It does not survive a reboot.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { pidAlive } from '../lib/process.js';
import { logPath, PACKAGE_ROOT, stateDir } from '../paths.js';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

export function fallbackPidPath(): string {
  return path.join(stateDir(), 'supervisor.pid');
}

function readPid(): number | null {
  const record = readJson<{ pid?: unknown }>(fallbackPidPath(), {});
  return Number.isInteger(record.pid) ? (record.pid as number) : null;
}

function start() {
  const running = readPid();
  if (pidAlive(running)) return { ok: true as const, alreadyRunning: true, pid: running };
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
    return { ok: true as const, pid: child.pid, note: 'this fallback does not survive a reboot' };
  } finally {
    fs.closeSync(logFd);
  }
}

function stopAndForget() {
  const pid = readPid();
  if (pid !== null && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Exited between the check and the signal.
    }
  }
  fs.rmSync(fallbackPidPath(), { force: true });
  return { ok: true as const, stoppedPid: pid };
}

export const detached: KeepaliveBackend = {
  name: 'supervisor',

  status(): KeepaliveStatus {
    const pid = readPid();
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
  },

  install: start,
  uninstall: stopAndForget,

  restart() {
    stopAndForget();
    return start();
  },

  stop() {
    stopAndForget();
  },

  logsHint() {
    return `tail -f ${logPath('supervisor')}`;
  },
};
