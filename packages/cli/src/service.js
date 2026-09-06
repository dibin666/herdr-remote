'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  PACKAGE_ROOT,
  bindAddress,
  configDir,
  loadConfig,
  resolveAdminOrigin,
  resolveHostRelayUrl,
  resolvePublicUrl,
  runsLocalRelay,
  runtimeStatePath,
  stateDir,
} = require('./config');
const { ensureDir, randomToken, readJson, writeJsonAtomic } = require('./state');
const {
  probeTerminalPalette,
  paletteFromEnvironment,
  rememberTerminalPalette,
  rememberedTerminalPalette,
} = require('./terminal-palette');
const { resolveSocketPath } = require('./socket-discovery');
const { preferredLanAddress } = require('./net-interfaces');
const { resolveHerdrCommand } = require('./herdr-command');

const RUNTIME_VERSION = 2;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readRuntime() {
  const state = readJson(runtimeStatePath(), {});
  return state && typeof state === 'object' ? state : {};
}

/**
 * Load (creating if needed) the long-lived identifiers and secrets this
 * workstation uses. These live in the state directory rather than config.json
 * because they are credentials: writeJsonAtomic stores them mode 0600.
 */
function ensureRuntime() {
  ensureDir(configDir());
  ensureDir(stateDir());
  const state = readRuntime();
  if (!state.version) state.version = RUNTIME_VERSION;
  if (!state.hostId) state.hostId = `host-${randomToken(9)}`;
  if (!state.hostToken) state.hostToken = randomToken(32);
  writeJsonAtomic(runtimeStatePath(), state);
  return state;
}

/**
 * Set the password used to join a relay. An empty value means "no password",
 * which is what a public relay expects.
 *
 * It lives in the state file rather than config.json because it is a secret:
 * writeJsonAtomic stores that file mode 0600.
 */
function setRelayPassword(password) {
  const state = ensureRuntime();
  state.relayPassword = typeof password === 'string' ? password.trim() : '';
  writeJsonAtomic(runtimeStatePath(), state);
  return state;
}

/**
 * Issue this workstation a new identity on the relay.
 *
 * The host token is what proves ownership of this workstation, so replacing it
 * means the relay no longer recognises the old one — useful if it leaked, but
 * it also orphans the previous record on a relay that already enrolled it.
 */
function regenerateHostIdentity() {
  const state = ensureRuntime();
  state.hostId = `host-${randomToken(9)}`;
  state.hostToken = randomToken(32);
  writeJsonAtomic(runtimeStatePath(), state);
  return state;
}

/**
 * The colors of the terminal this workstation is looked at through.
 *
 * Asked once per process, from whichever start path has a real terminal, and
 * remembered in the state file: a later start from a service manager has no
 * terminal to ask, and the workstation's appearance has not changed just
 * because systemd, and not a person, launched it this time.
 */
let cachedTerminalPalette;
function hostTerminalPalette({ refresh = false } = {}) {
  if (!refresh && cachedTerminalPalette !== undefined) return cachedTerminalPalette;

  const inherited = paletteFromEnvironment();
  if (inherited) {
    cachedTerminalPalette = inherited;
    return cachedTerminalPalette;
  }

  const probed = probeTerminalPalette();
  if (probed) {
    cachedTerminalPalette = rememberTerminalPalette(probed);
    return cachedTerminalPalette;
  }

  // Nothing to ask: fall back to what a start with a terminal wrote down,
  // re-validated, because a state file is not a trusted wire either.
  cachedTerminalPalette = rememberedTerminalPalette();
  return cachedTerminalPalette;
}

function logPath(name) {
  return path.join(stateDir(), `${name}.log`);
}

function relayBinPath() {
  // Resolved rather than hard-coded: the relay is a separate npm package, so
  // its location depends on how npm hoisted it.
  const manifest = require.resolve('herdr-remote-relay/package.json');
  return path.join(path.dirname(manifest), 'bin', 'herdr-remote-relay.js');
}

function relayAuthStatePath() {
  return path.join(stateDir(), 'relay-auth.json');
}

/**
 * The processes that make up a running herdr-remote, as declarative specs.
 *
 * Both the detached starter and the foreground supervisor build their children
 * from this one list so the two paths cannot drift in how they configure the
 * relay or the host connector.
 */
function serviceSpecs(config = loadConfig(), state = ensureRuntime()) {
  const specs = [];
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

  specs.push({
    name: 'host',
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, 'src', 'host-connector.js')],
    env: {
      // Captured here, where a terminal may still be attached, because the
      // connector itself usually runs detached with no terminal to ask.
      ...(terminalPalette ? { HERDR_TERM_PALETTE_JSON: JSON.stringify(terminalPalette) } : {}),
      RELAY_URL: resolveHostRelayUrl(config),
      RELAY_HOST_ID: state.hostId,
      RELAY_HOST_TOKEN: state.hostToken,
      RELAY_PASSWORD: runsLocalRelay(config) ? state.hostToken : (state.relayPassword || ''),
      HERDR_SOCKET_PATH: resolveSocketPath(config.herdr.socketPath),
      HERDR_ARGS_JSON: JSON.stringify(config.herdr.args),
      HERDR_CWD: config.herdr.cwd,
      HERDR_BIN_PATH: resolveHerdrCommand(),
    },
  });

  return specs;
}

function baseEnvironment() {
  return { ...process.env, HERDR_REMOTE_SERVICE: '1' };
}

function spawnDetached(spec) {
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

/**
 * Remember a process we started, in a list that survives being overwritten.
 *
 * `relayPid`/`hostPid` alone were not enough: the supervisor rewrote them with
 * its own children, which orphaned anything an earlier detached start had
 * spawned. Those orphans kept the port and the host session, so the relay could
 * never bind and "stop" had nothing left to kill. The ledger is append-only
 * (minus dead entries) precisely so no writer can lose another writer's pids.
 */
function recordManagedPid(state, name, pid) {
  const existing = Array.isArray(state.managedPids) ? state.managedPids : [];
  const kept = existing.filter((entry) => entry && entry.pid !== pid && pidAlive(entry.pid));
  // Only track something that is actually running: a pid that already exited
  // would sit in the ledger until its number is recycled by an unrelated
  // process, which we would then happily signal.
  if (Number.isInteger(pid) && pidAlive(pid)) {
    kept.push({ name, pid, startedAt: new Date().toISOString() });
  }
  state.managedPids = kept;
  return state;
}

/** Every process we believe we started, alive right now. */
function managedPids(state = readRuntime()) {
  const pids = new Map();
  // Supervisor first and never overwritten: `stopServices` relies on the order
  // to signal it before its children, and one pid can appear under several
  // fields.
  for (const [name, pid] of [['supervisor', state.supervisorPid], ['host', state.hostPid], ['relay', state.relayPid]]) {
    if (pidAlive(pid) && !pids.has(pid)) pids.set(pid, name);
  }
  for (const entry of state.managedPids || []) {
    if (entry && pidAlive(entry.pid) && !pids.has(entry.pid)) pids.set(entry.pid, entry.name);
  }
  return [...pids].map(([pid, name]) => ({ pid, name }));
}

function startServices() {
  const config = loadConfig();
  const state = ensureRuntime();
  const next = { ...state };
  const specs = serviceSpecs(config, state);

  for (const spec of specs) {
    const pidKey = `${spec.name}Pid`;
    if (pidAlive(next[pidKey])) continue;
    next[pidKey] = spawnDetached(spec);
    recordManagedPid(next, spec.name, next[pidKey]);
  }
  // A relay that is no longer part of the plan (switched to remote mode) must
  // not be left running on the old port.
  if (!specs.some((spec) => spec.name === 'relay') && pidAlive(next.relayPid)) {
    try { process.kill(next.relayPid, 'SIGTERM'); } catch {}
    next.relayPid = null;
  }

  next.startedAt = next.startedAt || new Date().toISOString();
  next.mode = config.relay.mode;
  writeJsonAtomic(runtimeStatePath(), next);
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

function stopServices() {
  const state = readRuntime();
  const stopped = [];

  // Supervisor first: it would otherwise see its children die and restart them
  // faster than we can kill them.
  const targets = managedPids(state).sort((a, b) => (
    (a.name === 'supervisor' ? 0 : 1) - (b.name === 'supervisor' ? 0 : 1)
  ));

  for (const { pid, name } of targets) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped.push({ name, pid });
    } catch (error) {
      process.stderr.write(`herdr-remote: could not stop ${name} (pid ${pid}): ${error.message}\n`);
    }
  }

  state.hostPid = null;
  state.relayPid = null;
  state.supervisorPid = null;
  state.managedPids = [];
  state.startedAt = null;
  ensureDir(stateDir());
  writeJsonAtomic(runtimeStatePath(), state);
  return { ok: true, stopped };
}

function restartServices() {
  stopServices();
  return startServices();
}

/**
 * Minimal JSON client. Picks http or https from the URL: a self-hosted relay is
 * reached over https, while the local relay is plain http on loopback.
 */
function requestJson(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (error) { return reject(error); }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 1500,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
        if (response.statusCode >= 400) {
          const error = new Error(body.message || `HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.body = body;
          reject(error);
        } else resolve(body);
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function healthUrl(config) {
  return `${resolveAdminOrigin(config)}/healthz`;
}

async function waitForRelay(config, { attempts = 20, delayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await requestJson(healthUrl(config), { timeout: 800 }); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError || new Error('relay did not become ready');
}

async function waitForHost(config, { attempts = 30, delayMs = 100 } = {}) {
  const state = ensureRuntime();
  const statusEndpoint = `${resolveAdminOrigin(config)}/api/status`;
  let lastStatus = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastStatus = await requestJson(statusEndpoint, {
        timeout: 800,
        headers: {
          'X-Herdr-Host-Id': state.hostId,
          'X-Herdr-Host-Token': state.hostToken,
        },
      });
      if (lastStatus.hosts?.some((host) => host.id === state.hostId)) return lastStatus;
    } catch (error) {
      lastStatus = { ok: false, message: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const error = new Error(lastStatus?.message || 'the Herdr host connector did not register with the relay');
  error.health = lastStatus;
  throw error;
}

async function statusServices() {
  const config = loadConfig();
  const state = readRuntime();
  const lanAddress = preferredLanAddress();
  let health = null;
  try {
    health = await requestJson(healthUrl(config), { timeout: 1200 });
  } catch (error) {
    health = { ok: false, message: error.message };
  }
  const socketPath = resolveSocketPath(config.herdr.socketPath);
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
    },
    publicUrl: resolvePublicUrl(config, lanAddress),
    startedAt: state.startedAt || null,
  };
}

async function pair() {
  const config = loadConfig();
  const state = ensureRuntime();
  if (runsLocalRelay(config)) startServices();
  await waitForRelay(config);
  await waitForHost(config);
  // Authenticated with this workstation's own host token: on a shared relay
  // that is what proves the pairing code is being minted for our terminal and
  // nobody else's.
  const pairing = await requestJson(`${resolveAdminOrigin(config)}/api/pair/start`, {
    method: 'POST',
    headers: {
      'X-Herdr-Host-Id': state.hostId,
      'X-Herdr-Host-Token': state.hostToken,
    },
    timeout: 5000,
  });
  return pairing;
}

function extractPairingCode(response) {
  const code = response?.code || response?.pairCode;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('the relay response did not contain a valid pairing code');
  }
  return code;
}

function readLogTail(name, lines = 40) {
  try {
    const content = fs.readFileSync(logPath(name), 'utf8');
    return content.split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

module.exports = {
  RUNTIME_VERSION,
  pidAlive,
  readRuntime,
  ensureRuntime,
  recordManagedPid,
  managedPids,
  setRelayPassword,
  regenerateHostIdentity,
  serviceSpecs,
  baseEnvironment,
  hostTerminalPalette,
  startServices,
  stopServices,
  restartServices,
  statusServices,
  requestJson,
  waitForRelay,
  waitForHost,
  pair,
  extractPairingCode,
  relayBinPath,
  relayAuthStatePath,
  logPath,
  readLogTail,
};
