'use strict';

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

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectSocket } = require('./socket-discovery');
const { ensureDir } = require('./state');

/** A Unix socket either accepts at once or is dead; this only guards a hang. */
const PROBE_TIMEOUT_MS = 1_000;
/** Herdr restores the saved session before its API socket opens. */
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;

/**
 * Is Herdr's server answering on `socketPath`?
 *
 * Resolves `{ state }`: `running`, `stopped` (no socket, or a socket nothing is
 * listening on), or `unavailable` with a `reason` — a path that is not a socket
 * or belongs to another user. That last one is never "stopped": the socket may
 * well be live, just not ours to use, and starting a second server beside it
 * would be starting somebody else's Herdr.
 */
function probeHerdrServer(socketPath, { connect = net.connect, timeout = PROBE_TIMEOUT_MS } = {}) {
  const info = inspectSocket(socketPath);
  if (!info.ok) {
    return Promise.resolve(
      info.missing ? { state: 'stopped' } : { state: 'unavailable', reason: info.reason },
    );
  }
  return new Promise((resolve) => {
    let socket;
    const finish = (result) => {
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
    socket = connect(socketPath);
    socket.once('connect', () => finish({ state: 'running' }));
    socket.once('error', (error) =>
      finish(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? { state: 'stopped', stale: true }
          : { state: 'unavailable', reason: error.message },
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
} = {}) {
  if (platform !== 'linux') return false;
  try {
    const unified = readCgroup()
      .split('\n')
      .find((line) => line.startsWith('0::'));
    return Boolean(unified) && /\.service$/.test(unified.trim());
  } catch {
    return false;
  }
}

/** The server's environment: the one a Herdr pane would give its client. */
function serverEnv(socketPath, env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('HERDR_')) delete next[key];
  }
  if (socketPath) next.HERDR_SOCKET_PATH = socketPath;
  return next;
}

/**
 * The argv that starts Herdr's server: Herdr's own global arguments (a
 * `--session`, say) followed by `server`, wrapped in `systemd-run --scope` when
 * the caller is a systemd service.
 */
function serverCommand({ command, args = [], inService = runningInSystemdService() }) {
  const herdr = [command, ...args, 'server'];
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
  spawnProcess = spawn,
  inService,
}) {
  const { file, args: argv } = serverCommand({ command, args, inService });
  ensureDir(path.dirname(logPath));
  const out = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawnProcess(file, argv, {
      cwd,
      env: serverEnv(socketPath),
      detached: true,
      stdio: ['ignore', out, out],
    });
  } finally {
    fs.closeSync(out);
  }
  child.on('error', () => {});
  child.unref();
  return child;
}

function readLogTail(logPath, bytes = 2_000) {
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
}) {
  const before = await probe(socketPath);
  if (before.state === 'running') return { started: false };
  if (before.state === 'unavailable') {
    throw new Error(`Herdr socket at ${socketPath} cannot be used: ${before.reason}`);
  }

  const child = launch({ command, args, socketPath, cwd, logPath });
  let exit = null;
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

module.exports = {
  PROBE_TIMEOUT_MS,
  START_TIMEOUT_MS,
  probeHerdrServer,
  runningInSystemdService,
  serverEnv,
  serverCommand,
  launchHerdrServer,
  ensureHerdrServer,
};
