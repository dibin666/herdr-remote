// The processes that make up a running herdr-remote — the local relay and the
// host connector — and starting, stopping and describing them.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PairStartResponse } from 'herdr-remote-relay/protocol';
import { ensureDir } from 'herdr-remote-relay/state';
import { loadConfig } from './config.js';
import {
  findHerdrCommand,
  herdrVersion,
  MIN_HERDR_VERSION,
  resolveHerdrCommand,
} from './herdr-command.js';
import { pidAlive } from './lib/process.js';
import { preferredLanAddress } from './net-interfaces.js';
import { PACKAGE_ROOT, stateDir } from './paths.js';
import { healthUrl, hostHeaders, requestJson, waitForHost, waitForRelay } from './relay-client.js';
import {
  bindAddress,
  resolveAdminOrigin,
  resolveHostRelayUrl,
  resolvePublicUrl,
  runsLocalRelay,
} from './relay-urls.js';
import {
  ensureRuntime,
  managedPids,
  type RuntimeState,
  readRuntime,
  recordManagedPid,
  updateRuntime,
  writeRuntime,
} from './runtime.js';
import { resolveSocketPath } from './socket-discovery.js';
import { resolveHostFont } from './terminal-font.js';
import { hostTerminalPalette } from './terminal-palette.js';

/** One process to run, declaratively. */
export interface ServiceSpec {
  name: 'relay' | 'host';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function logPath(name: string): string {
  return path.join(stateDir(), `${name}.log`);
}

export function relayBinPath(): string {
  // Resolved rather than hard-coded: the relay is a separate npm package, so
  // its location depends on how npm hoisted it.
  const manifest = createRequire(import.meta.url).resolve('herdr-remote-relay/package.json');
  return path.join(path.dirname(manifest), 'bin', 'herdr-remote-relay.js');
}

function relayAuthStatePath(): string {
  return path.join(stateDir(), 'relay-auth.json');
}

/**
 * The processes that make up a running herdr-remote, as declarative specs.
 *
 * Both the detached starter and the foreground supervisor build their children
 * from this one list so the two paths cannot drift in how they configure the
 * relay or the host connector.
 */
export function serviceSpecs(config = loadConfig(), state = ensureRuntime()): ServiceSpec[] {
  const specs: ServiceSpec[] = [];
  const publicUrl = resolvePublicUrl(config, preferredLanAddress());

  if (runsLocalRelay(config)) {
    specs.push({
      name: 'relay',
      command: process.execPath,
      args: [relayBinPath()],
      env: {
        // Let the shared web UI tell a private workstation relay apart from
        // the operator-facing self-hosted relay. Standalone relay installs
        // default to remote mode.
        RELAY_DEPLOYMENT_MODE: 'local',
        RELAY_BIND: bindAddress(config),
        RELAY_PORT: String(config.relay.port),
        RELAY_PUBLIC_URL: publicUrl,
        // A relay we start ourselves is closed to everything but this
        // workstation: reusing the host token as its password costs nothing and
        // stops another machine on the LAN from enrolling into it.
        RELAY_PASSWORD: state.hostToken,
        RELAY_AUTH_STATE_FILE: relayAuthStatePath(),
        RELAY_ALLOWED_ORIGINS: (config.relay.allowedOrigins || []).join(','),
        RELAY_MAX_CLIENTS_PER_HOST: String(config.relay.maxClientsPerHost),
        RELAY_MAX_HOSTS: String(config.relay.maxHosts),
        RELAY_MAX_PENDING_HANDSHAKES: String(config.relay.maxPendingHandshakes),
        RELAY_MAX_BUFFERED_BYTES_PER_CLIENT: String(config.relay.maxBufferedBytesPerClient),
        RELAY_HOST_RECONNECT_GRACE_MS: String(config.relay.hostReconnectGraceMs),
      },
    });
  }

  const terminalPalette = hostTerminalPalette();
  // What this command detected at its entry point, else what an earlier start
  // with a terminal wrote down. Only the family, size and terminal travel here;
  // the connector finds the files itself, on the machine that has them.
  const terminalFont = resolveHostFont();

  specs.push({
    name: 'host',
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, 'dist', 'connector', 'main.js')],
    env: {
      // Captured here, where a terminal may still be attached, because the
      // connector itself usually runs detached with no terminal to ask.
      ...(terminalPalette ? { HERDR_TERM_PALETTE_JSON: JSON.stringify(terminalPalette) } : {}),
      ...(terminalFont ? { HERDR_TERM_FONT_JSON: JSON.stringify(terminalFont) } : {}),
      RELAY_URL: resolveHostRelayUrl(config),
      RELAY_HOST_ID: state.hostId,
      RELAY_HOST_TOKEN: state.hostToken,
      RELAY_PASSWORD: runsLocalRelay(config) ? state.hostToken : state.relayPassword || '',
      HERDR_SOCKET_PATH: resolveSocketPath(config.herdr.socketPath),
      HERDR_ARGS_JSON: JSON.stringify(config.herdr.args),
      HERDR_CWD: config.herdr.cwd,
      HERDR_BIN_PATH: resolveHerdrCommand(),
    },
  });

  return specs;
}

export function baseEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, HERDR_REMOTE_SERVICE: '1' };
}

function spawnDetached(spec: ServiceSpec): number | undefined {
  ensureDir(stateDir());
  const logFd = fs.openSync(logPath(spec.name), 'a');
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: PACKAGE_ROOT,
      env: { ...baseEnvironment(), ...spec.env },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

/** Where each service's pid is kept in runtime.json. */
const PID_FIELDS = { relay: 'relayPid', host: 'hostPid' } as const;

export function startServices() {
  const config = loadConfig();
  const state = ensureRuntime();
  const next: RuntimeState = { ...state };
  const specs = serviceSpecs(config, state);

  for (const spec of specs) {
    const field = PID_FIELDS[spec.name];
    if (pidAlive(next[field])) continue;
    next[field] = spawnDetached(spec) ?? null;
    recordManagedPid(next, spec.name, next[field]);
  }
  // A relay that is no longer part of the plan (switched to remote mode) must
  // not be left running on the old port.
  if (!specs.some((spec) => spec.name === 'relay') && pidAlive(next.relayPid)) {
    try {
      process.kill(next.relayPid as number, 'SIGTERM');
    } catch {
      // Exited between the check and the signal: the port is free either way.
    }
    next.relayPid = null;
  }

  next.startedAt = next.startedAt || new Date().toISOString();
  next.mode = config.relay.mode;
  writeRuntime(next);
  return {
    ok: true,
    mode: config.relay.mode,
    relay: {
      local: runsLocalRelay(config),
      pid: next.relayPid || null,
      alive: pidAlive(next.relayPid),
      bind: runsLocalRelay(config) ? bindAddress(config) : null,
      port: config.relay.port,
      remoteUrl: config.relay.remoteUrl || null,
    },
    host: {
      pid: next.hostPid || null,
      alive: pidAlive(next.hostPid),
      socketPath: resolveSocketPath(config.herdr.socketPath),
    },
    publicUrl: resolvePublicUrl(config, preferredLanAddress()),
  };
}

export function stopServices() {
  const stopped: { name: string; pid: number }[] = [];
  ensureDir(stateDir());
  updateRuntime((state) => {
    // Supervisor first: it would otherwise see its children die and restart
    // them faster than we can kill them.
    const targets = managedPids(state).sort(
      (a, b) => (a.name === 'supervisor' ? 0 : 1) - (b.name === 'supervisor' ? 0 : 1),
    );
    for (const { pid, name } of targets) {
      try {
        process.kill(pid, 'SIGTERM');
        stopped.push({ name, pid });
      } catch (error) {
        process.stderr.write(
          `herdr-remote: could not stop ${name} (pid ${pid}): ${(error as Error).message}\n`,
        );
      }
    }
    state.hostPid = null;
    state.relayPid = null;
    state.supervisorPid = null;
    state.managedPids = [];
    state.startedAt = null;
  });
  return { ok: true, stopped };
}

export function restartServices() {
  stopServices();
  return startServices();
}

export async function statusServices() {
  const config = loadConfig();
  const state = readRuntime();
  const lanAddress = preferredLanAddress();
  let health: { ok?: boolean; message?: string; [key: string]: unknown };
  try {
    health = await requestJson(healthUrl(config), { timeout: 1200 });
  } catch (error) {
    health = { ok: false, message: (error as Error).message };
  }
  const socketPath = resolveSocketPath(config.herdr.socketPath);
  // Where Herdr was found, and whether it was found at all: under a service
  // manager this is the first thing to check when sessions will not start.
  const herdr = findHerdrCommand();
  // Only worth spawning when there is something to spawn; an unresolved command
  // has already answered the question the version would.
  const installed = herdr.found
    ? herdrVersion({ command: herdr.command })
    : { version: null, supported: true };
  return {
    ok: true,
    mode: config.relay.mode,
    relay: {
      local: runsLocalRelay(config),
      pid: state.relayPid || null,
      alive: runsLocalRelay(config) ? pidAlive(state.relayPid) : null,
      bind: runsLocalRelay(config) ? bindAddress(config) : null,
      port: config.relay.port,
      remoteUrl: config.relay.remoteUrl || null,
      health,
    },
    host: {
      pid: state.hostPid || null,
      alive: pidAlive(state.hostPid),
      hostId: state.hostId || null,
      socketPath,
      socketExists: Boolean(socketPath) && fs.existsSync(socketPath),
      herdrCommand: herdr.command,
      herdrCommandFound: herdr.found,
      herdrCommandSource: herdr.source,
      herdrVersion: installed.version,
      herdrVersionSupported: installed.supported,
      herdrVersionMinimum: MIN_HERDR_VERSION,
    },
    publicUrl: resolvePublicUrl(config, lanAddress),
    startedAt: state.startedAt || null,
  };
}

/** Start what pairing needs, then ask the relay for a code. */
export async function pair(): Promise<PairStartResponse> {
  const config = loadConfig();
  if (runsLocalRelay(config)) startServices();
  await waitForRelay(config);
  await waitForHost(config);
  // Authenticated with this workstation's own host token: on a shared relay
  // that is what proves the pairing code is being minted for our terminal and
  // nobody else's.
  return requestJson(`${resolveAdminOrigin(config)}/api/pair/start`, {
    method: 'POST',
    headers: hostHeaders(),
    timeout: 5000,
  });
}

export function readLogTail(name: string, lines = 40): string[] {
  try {
    const content = fs.readFileSync(logPath(name), 'utf8');
    return content.split('\n').filter(Boolean).slice(-lines);
  } catch {
    // No log yet: the service has never run.
    return [];
  }
}
