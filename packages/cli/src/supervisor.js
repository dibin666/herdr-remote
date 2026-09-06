'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { PACKAGE_ROOT, loadConfig, runtimeStatePath, stateDir } = require('./config');
const { ensureDir, readJson, writeJsonAtomic } = require('./state');
const { baseEnvironment, ensureRuntime, logPath, managedPids, pidAlive, recordManagedPid, serviceSpecs } = require('./service');
const { EXIT_REPLACED, EXIT_AUTH_FAILED } = require('./exit-codes');

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
// A child that stayed up this long is considered healthy, so the next crash
// starts backing off from scratch instead of inheriting an old penalty.
const HEALTHY_UPTIME_MS = 30_000;

/**
 * Runs the relay and host connector as managed children and restarts them when
 * they die.
 *
 * This is the process a service manager supervises: `herdr-remote run` stays in
 * the foreground so systemd/launchd can track it, and the same class backs the
 * fallback daemon on systems where neither is available.
 */
class Supervisor {
  constructor({ config = loadConfig(), state = ensureRuntime(), logToFiles = false, onEvent = null } = {}) {
    this.config = config;
    this.state = state;
    this.logToFiles = logToFiles;
    this.onEvent = onEvent;
    this.children = new Map();
    this.stopping = false;
  }

  emit(event) {
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
  async reclaimStrays({ timeoutMs = 5000 } = {}) {
    const strays = managedPids().filter((entry) => entry.pid !== process.pid);
    if (strays.length === 0) return strays;

    for (const { pid, name } of strays) {
      this.emit({ type: 'reclaim', name, pid, message: `stopping stray ${name} from an earlier start (pid ${pid})` });
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }

    // Wait for them to actually go: the relay only releases its port on exit,
    // and spawning ours before then just reproduces the EADDRINUSE loop.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (strays.every(({ pid }) => !pidAlive(pid))) return strays;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    for (const { pid, name } of strays) {
      if (!pidAlive(pid)) continue;
      this.emit({ type: 'reclaim', name, pid, message: `stray ${name} (pid ${pid}) ignored SIGTERM, killing` });
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return strays;
  }

  async start() {
    this.stopping = false;
    ensureDir(stateDir());
    await this.reclaimStrays();
    if (this.stopping) return;
    for (const spec of serviceSpecs(this.config, this.state)) {
      this.children.set(spec.name, { spec, child: null, pid: null, restarts: 0, backoffMs: MIN_BACKOFF_MS, timer: null });
      this.spawnChild(spec.name);
    }
    this.persistPids();
  }

  spawnChild(name) {
    if (this.stopping) return;
    const entry = this.children.get(name);
    if (!entry || entry.child) return;

    let stdio = ['ignore', 'inherit', 'inherit'];
    let fd = null;
    if (this.logToFiles) {
      fd = fs.openSync(logPath(name), 'a');
      stdio = ['ignore', fd, fd];
    }

    let child;
    try {
      child = spawn(entry.spec.command, entry.spec.args, {
        cwd: PACKAGE_ROOT,
        env: { ...baseEnvironment(), ...entry.spec.env },
        stdio,
      });
    } catch (error) {
      this.emit({ type: 'spawn_failed', name, message: `could not start ${name}: ${error.message}` });
      this.scheduleRestart(name);
      return;
    } finally {
      // The child inherited the descriptor during spawn, so this copy is done.
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    entry.child = child;
    entry.pid = child.pid;
    entry.startedAt = Date.now();
    this.emit({ type: 'started', name, pid: child.pid, message: `${name} started (pid ${child.pid})` });
    this.persistPids();

    child.on('exit', (code, signal) => {
      const uptimeMs = Date.now() - entry.startedAt;
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

  scheduleRestart(name) {
    if (this.stopping) return;
    const entry = this.children.get(name);
    if (!entry || entry.timer) return;
    const delay = entry.backoffMs;
    entry.restarts += 1;
    entry.backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(entry.backoffMs * 2));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.spawnChild(name);
    }, delay);
    entry.timer.unref?.();
  }

  persistPids() {
    try {
      const current = readJson(runtimeStatePath(), {});
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
      writeJsonAtomic(runtimeStatePath(), current);
    } catch (error) {
      process.stderr.write(`herdr-remote supervisor: could not persist pids: ${error.message}\n`);
    }
  }

  async stop({ graceMs = 5000 } = {}) {
    this.stopping = true;
    const pending = [];
    for (const entry of this.children.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const child = entry.child;
      if (!child) continue;
      pending.push(new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, graceMs);
        killTimer.unref?.();
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        try { child.kill('SIGTERM'); } catch { resolve(); }
      }));
    }
    await Promise.all(pending);
    try {
      const current = readJson(runtimeStatePath(), {});
      current.supervisorPid = null;
      current.relayPid = null;
      current.hostPid = null;
      current.startedAt = null;
      current.managedPids = (current.managedPids || []).filter((entry) => entry && pidAlive(entry.pid));
      writeJsonAtomic(runtimeStatePath(), current);
    } catch {}
  }
}

/** Entry point for `herdr-remote run`: supervise in the foreground until told to stop. */
async function runForeground({ logToFiles = false } = {}) {
  const supervisor = new Supervisor({ logToFiles });
  await supervisor.start();

  return new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      supervisor.emit({ type: 'shutdown', message: `${signal} received, stopping services` });
      await supervisor.stop();
      resolve(0);
    };
    process.on('SIGINT', () => { shutdown('SIGINT'); });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    process.on('SIGHUP', () => { shutdown('SIGHUP'); });
  });
}

module.exports = { Supervisor, runForeground, MIN_BACKOFF_MS, MAX_BACKOFF_MS, HEALTHY_UPTIME_MS };
