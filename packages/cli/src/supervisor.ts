import fs from 'node:fs';
import { type ChildProcess, type StdioOptions, spawn } from 'node:child_process';
import { type Config, loadConfig } from './config.js';
import { logPath, PACKAGE_ROOT, stateDir } from './paths.js';
import { ensureDir } from 'herdr-remote-relay/state';
import {
  type RuntimeState,
  ensureRuntime,
  managedPids,
  recordManagedPid,
  updateRuntime,
} from './runtime.js';
import { type ServiceSpec, baseEnvironment, serviceSpecs } from './service.js';
import { EXIT_REPLACED, EXIT_AUTH_FAILED } from './exit-codes.js';
import { pidAlive } from './lib/process.js';

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
// A child that stayed up this long is considered healthy, so the next crash
// starts backing off from scratch instead of inheriting an old penalty.
const HEALTHY_UPTIME_MS = 30_000;

/** Something the supervisor did, as it reports it. */
export interface SupervisorEvent {
  type: string;
  message: string;
  name?: string;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

interface ChildEntry {
  spec: ServiceSpec;
  child: ChildProcess | null;
  pid: number | null | undefined;
  restarts: number;
  backoffMs: number;
  timer: NodeJS.Timeout | null;
  startedAt?: number;
}

/**
 * Runs the relay and host connector as managed children and restarts them when
 * they die.
 *
 * This is the process a service manager supervises: `herdr-remote run` stays in
 * the foreground so systemd/launchd can track it, and the same class backs the
 * fallback daemon on systems where neither is available.
 */
class Supervisor {
  readonly config: Config;
  readonly state: RuntimeState;
  readonly logToFiles: boolean;
  readonly onEvent: ((event: SupervisorEvent) => void) | null;
  readonly children = new Map<string, ChildEntry>();
  stopping = false;

  constructor({
    config = loadConfig(),
    state = ensureRuntime(),
    logToFiles = false,
    onEvent = null,
  }: {
    config?: Config;
    state?: RuntimeState;
    logToFiles?: boolean;
    onEvent?: ((event: SupervisorEvent) => void) | null;
  } = {}) {
    this.config = config;
    this.state = state;
    this.logToFiles = logToFiles;
    this.onEvent = onEvent;
  }

  emit(event: SupervisorEvent): void {
    if (this.onEvent) this.onEvent(event);
    const line = `[${new Date().toISOString()}] herdr-remote supervisor: ${event.message}\n`;
    process.stdout.write(line);
  }

  /**
   * Stop anything a previous, unmanaged start left behind.
   *
   * Taking over without this is what produced the runaway: a detached relay
   * from `herdr-remote start` kept port 8787, so every relay this supervisor
   * spawned died with EADDRINUSE and retried forever, while the orphaned host
   * connector and ours both claimed the same host id on the relay and kicked
   * each other off — which is what browsers saw as an endless reconnect.
   */
  async reclaimStrays({ timeoutMs = 5000 } = {}): Promise<{ name: string; pid: number }[]> {
    const strays = managedPids().filter((entry) => entry.pid !== process.pid);
    if (strays.length === 0) return strays;

    for (const { pid, name } of strays) {
      this.emit({
        type: 'reclaim',
        name,
        pid,
        message: `stopping stray ${name} from an earlier start (pid ${pid})`,
      });
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }

    // Wait for them to actually go: the relay only releases its port on exit,
    // and spawning ours before then just reproduces the EADDRINUSE loop.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (strays.every(({ pid }) => !pidAlive(pid))) return strays;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    for (const { pid, name } of strays) {
      if (!pidAlive(pid)) continue;
      this.emit({
        type: 'reclaim',
        name,
        pid,
        message: `stray ${name} (pid ${pid}) ignored SIGTERM, killing`,
      });
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    return strays;
  }

  async start(): Promise<void> {
    this.stopping = false;
    ensureDir(stateDir());
    await this.reclaimStrays();
    if (this.stopping) return;
    for (const spec of serviceSpecs(this.config, this.state)) {
      this.children.set(spec.name, {
        spec,
        child: null,
        pid: null,
        restarts: 0,
        backoffMs: MIN_BACKOFF_MS,
        timer: null,
      });
      this.spawnChild(spec.name);
    }
    this.persistPids();
  }

  spawnChild(name: string): void {
    if (this.stopping) return;
    const entry = this.children.get(name);
    if (!entry || entry.child) return;

    let stdio: StdioOptions = ['ignore', 'inherit', 'inherit'];
    let fd: number | null = null;
    if (this.logToFiles) {
      fd = fs.openSync(logPath(name), 'a');
      stdio = ['ignore', fd, fd];
    }

    let child: ChildProcess;
    try {
      child = spawn(entry.spec.command, entry.spec.args, {
        cwd: PACKAGE_ROOT,
        env: { ...baseEnvironment(), ...entry.spec.env },
        stdio,
      });
    } catch (error) {
      this.emit({
        type: 'spawn_failed',
        name,
        message: `could not start ${name}: ${(error as Error).message}`,
      });
      this.scheduleRestart(name);
      return;
    } finally {
      // The child inherited the descriptor during spawn, so this copy is done.
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    entry.child = child;
    entry.pid = child.pid;
    entry.startedAt = Date.now();
    this.emit({
      type: 'started',
      name,
      pid: child.pid,
      message: `${name} started (pid ${child.pid})`,
    });
    this.persistPids();

    child.on('exit', (code, signal) => {
      const uptimeMs = Date.now() - (entry.startedAt ?? Date.now());
      entry.child = null;
      entry.pid = null;
      this.persistPids();
      if (this.stopping) return;
      if (code === EXIT_REPLACED) {
        this.emit({
          type: 'replaced',
          name,
          message: `${name} stood down: another instance owns this workstation. Not restarting it.`,
        });
        return;
      }
      if (code === EXIT_AUTH_FAILED) {
        this.emit({
          type: 'fatal',
          name,
          message: `${name} stopped: relay authentication failed. Update credentials before restarting it.`,
        });
        return;
      }
      if (uptimeMs >= HEALTHY_UPTIME_MS) entry.backoffMs = MIN_BACKOFF_MS;
      this.emit({
        type: 'exited',
        name,
        code,
        signal,
        message: `${name} exited (${signal || `code ${code}`}) after ${Math.round(uptimeMs / 1000)}s, restarting in ${entry.backoffMs}ms`,
      });
      this.scheduleRestart(name);
    });

    child.on('error', (error) => {
      this.emit({ type: 'error', name, message: `${name} error: ${error.message}` });
    });
  }

  scheduleRestart(name: string): void {
    if (this.stopping) return;
    const entry = this.children.get(name);
    if (!entry || entry.timer) return;
    const delay = entry.backoffMs;
    entry.restarts += 1;
    entry.backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(entry.backoffMs * 2));
    const timer = setTimeout(() => {
      entry.timer = null;
      this.spawnChild(name);
    }, delay);
    entry.timer = timer;
    timer.unref?.();
  }

  persistPids(): void {
    try {
      updateRuntime((current) => {
        current.supervisorPid = process.pid;
        current.relayPid = this.children.get('relay')?.pid || null;
        current.hostPid = this.children.get('host')?.pid || null;
        current.startedAt = current.startedAt || new Date().toISOString();
        current.mode = this.config.relay.mode;
        // Merge into the ledger rather than replacing it, so a pid recorded by
        // another writer is never dropped and left running with nobody tracking
        // it.
        recordManagedPid(current, 'supervisor', process.pid);
        for (const [name, entry] of this.children) {
          if (entry.pid) recordManagedPid(current, name, entry.pid);
        }
      });
    } catch (error) {
      process.stderr.write(
        `herdr-remote supervisor: could not persist pids: ${(error as Error).message}\n`,
      );
    }
  }

  async stop({ graceMs = 5000 } = {}): Promise<void> {
    this.stopping = true;
    const pending: Promise<void>[] = [];
    for (const entry of this.children.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const child = entry.child;
      if (!child) continue;
      pending.push(
        new Promise<void>((resolve) => {
          const killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve();
          }, graceMs);
          killTimer.unref?.();
          child.once('exit', () => {
            clearTimeout(killTimer);
            resolve();
          });
          try {
            child.kill('SIGTERM');
          } catch {
            resolve();
          }
        }),
      );
    }
    await Promise.all(pending);
    try {
      updateRuntime((current) => {
        current.supervisorPid = null;
        current.relayPid = null;
        current.hostPid = null;
        current.startedAt = null;
        current.managedPids = (current.managedPids || []).filter(
          (entry) => entry && pidAlive(entry.pid),
        );
      });
    } catch {}
  }
}

/** Entry point for `herdr-remote run`: supervise in the foreground until told to stop. */
async function runForeground({ logToFiles = false } = {}): Promise<number> {
  const supervisor = new Supervisor({ logToFiles });
  await supervisor.start();

  return new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      supervisor.emit({ type: 'shutdown', message: `${signal} received, stopping services` });
      await supervisor.stop();
      resolve(0);
    };
    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.on('SIGHUP', () => {
      shutdown('SIGHUP');
    });
  });
}

export { Supervisor, runForeground, MIN_BACKOFF_MS, MAX_BACKOFF_MS, HEALTHY_UPTIME_MS };
