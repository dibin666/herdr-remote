// Whether Herdr's server is running on this workstation, and starting it when
// the user asked for that.
//
// herdr-remote never starts Herdr on its own initiative. It starts one when a
// browser paired to this workstation asks for it, or at service start when the
// user switched that on — and both go through here.
//
// Two traps shape this file:
//
// - A socket file is not a server. Herdr leaves `herdr.sock` behind when it dies
//   without cleaning up (a crash, a power cut), and a `herdr` client pointed at
//   a dead socket quietly starts a server of its own. So "running" means a
//   connection was accepted, not that the path exists.
// - A server started from inside herdr-remote's systemd service lives in that
//   service's cgroup, and `systemctl restart herdr-remote` — an update, a keep-
//   alive restart, Herdr's own plugin startup hook — would kill it along with
//   every agent in it. Under a service it is therefore started in a transient
//   scope of its own, the same place it would live had the user started it
//   from a terminal.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { herdrVersion } from './herdr-command.js';
import { compareVersions } from './updater.js';
import { herdrEndpoint, inspectSocket } from './socket-discovery.js';
import { ensureDir } from 'herdr-remote-relay/state';

/** A Unix socket either accepts at once or is dead; this only guards a hang. */
const PROBE_TIMEOUT_MS = 1_000;
/** Herdr restores the saved session before its API socket opens. */
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;

/** How a Windows named pipe answers a client its integrity label keeps out. */
const ACCESS_DENIED_CODES = ['EPERM', 'EACCES'];
/** The first Herdr whose `server` takes `--allow-unelevated-clients`; older ones refuse to start. */
const UNELEVATED_CLIENTS_SINCE = '0.9.4';
/** Integrity levels above an ordinary token: High (administrator) and System. */
const ELEVATED_INTEGRITY = /S-1-16-(?:12288|16384)\b/;

export type ServerProbe =
  | { state: 'running' }
  | { state: 'stopped'; stale?: boolean }
  | { state: 'unavailable'; reason?: string; elevated?: boolean };

type Connect = (path: string) => net.Socket;
type SpawnProcess = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How to start Herdr's server: its binary, its global arguments, where it runs. */
export interface ServerLaunch {
  command: string;
  args?: string[];
  socketPath: string;
  cwd?: string;
  logPath: string;
}

/**
 * Why a connection to Herdr was refused, in words someone can act on.
 *
 * From Herdr 0.9.4 a Windows server started as administrator admits only
 * administrator clients, and the pipe answers everyone else with a bare access
 * denied that names neither the cause nor the way out.
 */
function refusal(error: NodeJS.ErrnoException, platform: NodeJS.Platform): ServerProbe {
  if (platform !== 'win32' || !ACCESS_DENIED_CODES.includes(error.code || '')) {
    return { state: 'unavailable', reason: error.message };
  }
  return {
    state: 'unavailable',
    elevated: true,
    reason:
      'Herdr is running as administrator and refuses clients that are not. Start Herdr from an ' +
      'ordinary terminal, or set allow_unelevated_clients = true under [server] in its ' +
      `config.toml and restart its server. (${error.message})`,
  };
}

/**
 * Is Herdr's server answering on `socketPath`?
 *
 * Resolves `{ state }`: `running`, `stopped` (no socket, or a socket nothing is
 * listening on), or `unavailable` with a `reason` — a path that is not a socket
 * or belongs to another user. That last one is never "stopped": the socket may
 * well be live, just not ours to use, and starting a second server beside it
 * would be starting somebody else's Herdr.
 */
function probeHerdrServer(
  socketPath: string,
  {
    connect = net.connect as Connect,
    timeout = PROBE_TIMEOUT_MS,
    platform = process.platform,
  }: { connect?: Connect; timeout?: number; platform?: NodeJS.Platform } = {},
): Promise<ServerProbe> {
  const info = inspectSocket(socketPath);
  if (!info.ok) {
    return Promise.resolve(
      info.missing ? { state: 'stopped' } : { state: 'unavailable', reason: info.reason },
    );
  }
  return new Promise((resolve) => {
    let socket: net.Socket | undefined;
    const finish = (result: ServerProbe) => {
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.destroy();
      }
      resolve(result);
    };
    // A socket that neither accepts nor refuses has a listener behind it that
    // is slow, not absent; starting another server would only fight it.
    const timer = setTimeout(() => finish({ state: 'running' }), timeout);
    if (typeof timer.unref === 'function') timer.unref();
    socket = connect(herdrEndpoint(socketPath, platform));
    socket.once('connect', () => finish({ state: 'running' }));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? { state: 'stopped', stale: true }
          : refusal(error, platform),
      ),
    );
  });
}

/**
 * True when this process is a systemd service (herdr-remote's keep-alive), so
 * anything it starts would be killed with it.
 */
function runningInSystemdService({
  platform = process.platform,
  readCgroup = () => fs.readFileSync('/proc/self/cgroup', 'utf8'),
}: {
  platform?: NodeJS.Platform;
  readCgroup?: () => string;
} = {}): boolean {
  if (platform !== 'linux') return false;
  try {
    const unified = readCgroup()
      .split('\n')
      .find((line) => line.startsWith('0::'));
    return unified !== undefined && /\.service$/.test(unified.trim());
  } catch {
    return false;
  }
}

/**
 * True when this process runs as administrator on Windows — under the
 * keep-alive Windows service, for one — so a Herdr server it starts runs
 * elevated too. Read from the token's integrity level, which `whoami` names by
 * SID in every display language.
 */
function runningElevated({
  platform = process.platform,
  whoamiGroups = () =>
    spawnSync('whoami', ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout || '',
}: {
  platform?: NodeJS.Platform;
  whoamiGroups?: () => string;
} = {}): boolean {
  if (platform !== 'win32') return false;
  try {
    return ELEVATED_INTEGRITY.test(whoamiGroups());
  } catch {
    // Unreadable: start Herdr as it always was started.
    return false;
  }
}

/**
 * Whether a server started from here should admit ordinary clients.
 *
 * From Herdr 0.9.4 an elevated server admits only administrator clients. One
 * herdr-remote starts as administrator would then turn away the user's own
 * terminal, which is not elevated, though the server is meant to be theirs:
 * as administrator is only how the service happens to run. The flag gives
 * back what every earlier Herdr did. A Herdr that cannot say its version is
 * left without it, since one too old for the flag would not start at all.
 */
function admitUnelevatedClients(command: string, elevated = runningElevated()): boolean {
  if (!elevated) return false;
  const { version } = herdrVersion({ command });
  return version !== null && compareVersions(version, UNELEVATED_CLIENTS_SINCE) >= 0;
}

/** The server's environment: the one a Herdr pane would give its client. */
function serverEnv(
  socketPath: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('HERDR_')) delete next[key];
  }
  if (socketPath) next.HERDR_SOCKET_PATH = socketPath;
  return next;
}

/**
 * The argv that starts Herdr's server: Herdr's own global arguments (a
 * `--session`, say) followed by `server` and, when asked for, the flag that
 * lets ordinary clients into an elevated server; wrapped in `systemd-run
 * --scope` when the caller is a systemd service.
 */
function serverCommand({
  command,
  args = [],
  inService = runningInSystemdService(),
  allowUnelevated = false,
}: {
  command: string;
  args?: string[];
  inService?: boolean;
  allowUnelevated?: boolean;
}): { file: string; args: string[] } {
  const herdr = [
    command,
    ...args,
    'server',
    ...(allowUnelevated ? ['--allow-unelevated-clients'] : []),
  ];
  if (!inService) return { file: herdr[0], args: herdr.slice(1) };
  return {
    file: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--description=Herdr server started by herdr-remote',
      '--',
      ...herdr,
    ],
  };
}

/**
 * Start Herdr's server in the background. Detached from this process, with its
 * output appended to `logPath` rather than piped here: a pipe would break the
 * moment herdr-remote exits and take the server with it.
 */
function launchHerdrServer({
  command,
  args = [],
  socketPath,
  cwd,
  logPath,
  spawnProcess = spawn as SpawnProcess,
  inService,
  allowUnelevated = admitUnelevatedClients(command),
}: ServerLaunch & {
  spawnProcess?: SpawnProcess;
  inService?: boolean;
  allowUnelevated?: boolean;
}): ChildProcess {
  const { file, args: argv } = serverCommand({ command, args, inService, allowUnelevated });
  ensureDir(path.dirname(logPath));
  const out = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawnProcess(file, argv, {
      cwd,
      env: serverEnv(socketPath),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
  } finally {
    fs.closeSync(out);
  }
  child.on('error', () => {});
  child.unref();
  return child;
}

function readLogTail(logPath: string, bytes = 2_000): string {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    return text.slice(-bytes).trim();
  } catch {
    return '';
  }
}

/**
 * Make sure Herdr's server is running, starting it if it is not.
 *
 * Resolves `{ started }`, or rejects with a message that says what happened:
 * the socket belongs to someone else, the server exited, or it never opened
 * its socket. The last lines Herdr printed ride along, because "did not start"
 * with no reason is a message nobody can act on.
 */
async function ensureHerdrServer({
  command,
  args = [],
  socketPath,
  cwd,
  logPath,
  probe = probeHerdrServer,
  launch = launchHerdrServer,
  timeout = START_TIMEOUT_MS,
  interval = START_POLL_MS,
}: ServerLaunch & {
  probe?: (socketPath: string) => Promise<ServerProbe>;
  launch?: (options: ServerLaunch) => ChildProcess;
  timeout?: number;
  interval?: number;
}): Promise<{ started: boolean }> {
  const before = await probe(socketPath);
  if (before.state === 'running') return { started: false };
  if (before.state === 'unavailable') {
    throw new Error(`Herdr socket at ${socketPath} cannot be used: ${before.reason}`);
  }

  const child = launch({ command, args, socketPath, cwd, logPath });
  // Assigned by the listener; `as` keeps TypeScript from assuming it stays null.
  let exit = null as { code: number | null; signal: NodeJS.Signals | null } | null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const deadline = Date.now() + timeout;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const now = await probe(socketPath);
    if (now.state === 'running') return { started: true };
    const tail = readLogTail(logPath);
    const detail = tail ? `\n${tail}` : '';
    if (exit) {
      throw new Error(
        `Herdr server exited (${exit.signal || `code ${exit.code}`}) before opening ${socketPath}.${detail}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Herdr server did not open ${socketPath} within ${Math.round(timeout / 1000)}s.${detail}`,
      );
    }
  }
}

export {
  admitUnelevatedClients,
  ensureHerdrServer,
  launchHerdrServer,
  probeHerdrServer,
  runningElevated,
  runningInSystemdService,
  serverCommand,
  serverEnv,
};
