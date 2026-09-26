// One host connector per workstation: a lock file naming the process that holds it.

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from 'herdr-remote-relay/state';
import { pidAlive } from '../lib/process.js';

function readOwner(lockPath: string): { pid?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    // Missing, or half-written by a process that died mid-write: nobody owns it.
    return null;
  }
}

function lockError(message: string, code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

/**
 * Take the lock, or throw `HOST_ALREADY_RUNNING` when a live process holds it.
 * A lock left by a dead process is removed and taken over.
 */
export function acquireHostLock(lockPath: string, hostId: string): number {
  ensureDir(path.dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, hostId, startedAt: new Date().toISOString() })}\n`,
      );
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwner(lockPath);
      if (owner && pidAlive(owner.pid)) {
        throw lockError(
          `another host connector is already running (pid ${owner.pid})`,
          'HOST_ALREADY_RUNNING',
        );
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Not ours to remove; the second attempt fails and says so below.
      }
    }
  }
  throw lockError('could not acquire host connector lock', 'HOST_LOCK_FAILED');
}

/** Close `fd` and remove the lock, unless another process has taken it since. */
export function releaseHostLock(lockPath: string, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed; the file below is what matters.
  }
  const owner = readOwner(lockPath);
  if (owner && owner.pid !== process.pid) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Stopping must not fail over a lock file; a dead owner's lock is taken over.
  }
}
