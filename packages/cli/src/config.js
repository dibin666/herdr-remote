'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Locate the package directory by walking up to our own package.json.
 *
 * `path.resolve(__dirname, '..')` was wrong as soon as this module started
 * being bundled into dist/tui.js, because the bundle sits at a different depth
 * than src/. Everything that matters — the plugin manifest, the host connector
 * entry point, the systemd unit's ExecStart — is resolved from this value, so
 * it has to be independent of where the code happens to be loaded from.
 */
function findPackageRoot(start) {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, 'package.json');
    try {
      if (JSON.parse(fs.readFileSync(candidate, 'utf8')).name === 'herdr-remote') return directory;
    } catch {
      // Keep climbing: a missing or unrelated package.json is expected.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(start, '..');
}

const PACKAGE_ROOT = findPackageRoot(__dirname);

// Access modes
//   local  — a relay runs on this machine, reachable only from this machine.
//   lan    — a relay runs on this machine, bound to every interface so other
//            devices on the LAN (or on a Tailscale/WireGuard overlay) reach it.
//   remote — no local relay; the host connector dials an operator-run relay,
//            which is the only way in from outside the local network.
const ACCESS_MODES = ['local', 'lan', 'remote'];

// The relay this project runs for people who do not want to host one. Offered
// as a one-keystroke choice during setup; it is never selected automatically,
// because routing a terminal through someone else's server has to be a
// deliberate decision. It is a plain public relay: no join password, and each
// workstation stays reachable only through its own host token.
const OFFICIAL_RELAY_URL = 'wss://herdr-remote.564616.xyz';
const LANGUAGES = ['auto', 'zh', 'en'];
const KEEPALIVE_MANAGERS = ['auto', 'systemd', 'launchd', 'supervisor', 'none'];

const DEFAULTS = {
  ui: {
    language: 'auto',
  },
  relay: {
    mode: 'local',
    port: 8787,
    // Address advertised in pairing URLs when mode is "lan". Empty means "pick
    // the first non-internal IPv4 automatically".
    lanHost: '',
    // Manual override for the URL browsers open. Empty means "derive it".
    publicUrl: '',
    // Operator-run relay, e.g. wss://herdr.example.com (mode "remote" only).
    remoteUrl: '',
    maxPayloadBytes: 1024 * 1024,
    maxClientsPerHost: 16,
    maxHosts: 1024,
    maxPendingHandshakes: 1024,
    maxBufferedBytesPerClient: 4 * 1024 * 1024,
    hostReconnectGraceMs: 30 * 1000,
    allowedOrigins: [],
  },
  herdr: {
    socketPath: null,
    args: [],
    cwd: os.homedir(),
  },
  auth: {
    pairingTtlMs: 10 * 60 * 1000,
    deviceTtlMs: 30 * 24 * 60 * 60 * 1000,
    maxDevices: 32,
  },
  cleanup: {
    intervalMs: 60 * 1000,
    heartbeatIntervalMs: 30 * 1000,
    staleAfterMs: 90 * 1000,
  },
  keepalive: {
    manager: 'auto',
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The canonical configuration directory.
 *
 * Deliberately NOT $HERDR_PLUGIN_CONFIG_DIR: Herdr sets that variable only when
 * it launches the plugin itself, so honouring it would give "herdr-remote" run
 * from a shell and the same tool run from a Herdr pane two different config
 * files. One path, one config; `migrateLegacyConfig()` imports the old one.
 */
function configDir() {
  return process.env.HERDR_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.config', 'herdr-remote');
}

function stateDir() {
  return process.env.HERDR_REMOTE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'herdr-remote');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function runtimeStatePath() {
  return path.join(stateDir(), 'runtime.json');
}

function legacyConfigPath() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR
    ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'config.json')
    : null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(`herdr-remote: ignoring invalid JSON at ${filePath}: ${error.message}\n`);
    }
    return {};
  }
}

/**
 * Copy a config written by an older, plugin-scoped install into the canonical
 * location. Runs at most once: it never overwrites an existing config.
 */
function migrateLegacyConfig() {
  const target = configPath();
  if (fs.existsSync(target)) return { migrated: false, reason: 'config already exists' };
  const legacy = legacyConfigPath();
  if (!legacy || !fs.existsSync(legacy)) return { migrated: false, reason: 'no legacy config' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(legacy, target);
    return { migrated: true, from: legacy, to: target };
  } catch (error) {
    return { migrated: false, reason: error.message };
  }
}

function mergeConfig(fileConfig) {
  const config = clone(DEFAULTS);
  for (const section of Object.keys(config)) {
    if (fileConfig && fileConfig[section] && typeof fileConfig[section] === 'object') {
      Object.assign(config[section], fileConfig[section]);
    }
  }
  return config;
}

/**
 * Accept configs written before access modes existed. The 0.1 schema used
 * `relay.local` (boolean), `relay.host` (bind address) and `relay.url`.
 */
function normalizeLegacyFields(config, fileConfig) {
  const legacy = (fileConfig && fileConfig.relay) || {};
  // The absence of an explicit `mode` — not an invalid one — is what marks a
  // file as pre-0.2, since merging defaults always leaves a valid mode behind.
  const hasExplicitMode = ACCESS_MODES.includes(legacy.mode);
  if (!hasExplicitMode) {
    if (legacy.local === false && typeof legacy.url === 'string' && legacy.url) {
      config.relay.mode = 'remote';
      if (!config.relay.remoteUrl) config.relay.remoteUrl = legacy.url;
    } else if (typeof legacy.host === 'string' && legacy.host && !isLoopbackHost(legacy.host)) {
      config.relay.mode = 'lan';
    } else {
      config.relay.mode = 'local';
    }
  }
  if (config.relay.mode === 'lan' && !config.relay.lanHost && typeof legacy.host === 'string' && !isLoopbackHost(legacy.host) && legacy.host !== '0.0.0.0') {
    config.relay.lanHost = legacy.host;
  }
  // Superseded keys copied in by the merge would otherwise reappear in the
  // in-memory config and confuse anything reading it.
  delete config.relay.local;
  delete config.relay.host;
  delete config.relay.url;
  // `publicUrl` used to be mandatory and defaulted to the loopback URL; treat
  // that default as "no override" so derivation can take over.
  if (typeof config.relay.publicUrl === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(config.relay.publicUrl)) {
    config.relay.publicUrl = '';
  }
}

function parseInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return fallback;
  return numeric;
}

function isLoopbackHost(value) {
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

function isUnspecifiedAddress(value) {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return address === '0.0.0.0' || address === '::' || address === '[::]';
}

/** An unspecified host is valid for a server bind, but not for a browser URL. */
function isUnspecifiedHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]';
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function validate(config) {
  if (!ACCESS_MODES.includes(config.relay.mode)) config.relay.mode = DEFAULTS.relay.mode;
  if (!LANGUAGES.includes(config.ui.language)) config.ui.language = DEFAULTS.ui.language;
  if (!KEEPALIVE_MANAGERS.includes(config.keepalive.manager)) config.keepalive.manager = DEFAULTS.keepalive.manager;

  config.relay.port = parseInteger(config.relay.port, DEFAULTS.relay.port, 1, 65535);
  config.relay.maxPayloadBytes = parseInteger(config.relay.maxPayloadBytes, DEFAULTS.relay.maxPayloadBytes, 4096, 16 * 1024 * 1024);
  config.relay.maxClientsPerHost = parseInteger(config.relay.maxClientsPerHost, DEFAULTS.relay.maxClientsPerHost, 1, 256);
  config.relay.maxHosts = parseInteger(config.relay.maxHosts, DEFAULTS.relay.maxHosts, 1, 100000);
  config.relay.maxPendingHandshakes = parseInteger(config.relay.maxPendingHandshakes, DEFAULTS.relay.maxPendingHandshakes, 16, 100000);
  config.relay.maxBufferedBytesPerClient = parseInteger(
    config.relay.maxBufferedBytesPerClient,
    DEFAULTS.relay.maxBufferedBytesPerClient,
    64 * 1024,
    256 * 1024 * 1024,
  );
  config.relay.hostReconnectGraceMs = parseInteger(
    config.relay.hostReconnectGraceMs,
    DEFAULTS.relay.hostReconnectGraceMs,
    1000,
    24 * 60 * 60 * 1000,
  );
  config.auth.pairingTtlMs = parseInteger(config.auth.pairingTtlMs, DEFAULTS.auth.pairingTtlMs, 30 * 1000, 24 * 60 * 60 * 1000);
  config.auth.deviceTtlMs = parseInteger(config.auth.deviceTtlMs, DEFAULTS.auth.deviceTtlMs, 60 * 1000, 365 * 24 * 60 * 60 * 1000);
  config.auth.maxDevices = parseInteger(config.auth.maxDevices, DEFAULTS.auth.maxDevices, 1, 10000);
  config.cleanup.intervalMs = parseInteger(config.cleanup.intervalMs, DEFAULTS.cleanup.intervalMs, 1000, 24 * 60 * 60 * 1000);
  config.cleanup.heartbeatIntervalMs = parseInteger(config.cleanup.heartbeatIntervalMs, DEFAULTS.cleanup.heartbeatIntervalMs, 1000, 10 * 60 * 1000);
  config.cleanup.staleAfterMs = parseInteger(config.cleanup.staleAfterMs, DEFAULTS.cleanup.staleAfterMs, config.cleanup.heartbeatIntervalMs * 2, 24 * 60 * 60 * 1000);

  config.relay.publicUrl = normalizeUrl(config.relay.publicUrl);
  config.relay.remoteUrl = normalizeUrl(config.relay.remoteUrl);
  config.relay.lanHost = typeof config.relay.lanHost === 'string' ? config.relay.lanHost.trim() : '';
  // A LAN relay listens on every interface, but a loopback or wildcard value
  // cannot be opened by another device. Clear stale values from older TUI
  // versions so the advertised URL falls back to a real interface address.
  if (config.relay.mode === 'lan'
    && (isLoopbackHost(config.relay.lanHost) || isUnspecifiedAddress(config.relay.lanHost))) {
    config.relay.lanHost = '';
  }
  // 0.0.0.0 is a server-side bind wildcard, never a destination a browser can
  // open. Treat it like an empty override so LAN mode derives the real address.
  if (isUnspecifiedHost(config.relay.publicUrl)) config.relay.publicUrl = '';
  if (!Array.isArray(config.relay.allowedOrigins)) config.relay.allowedOrigins = [];

  if (!Array.isArray(config.herdr.args) || !config.herdr.args.every((arg) => typeof arg === 'string')) {
    config.herdr.args = [];
  }
  // Herdr 0.9.0 removed --no-session; retaining it in saved configs causes
  // session creation to fail. Filter it out if present.
  if (config.herdr.args.includes('--no-session')) {
    config.herdr.args = config.herdr.args.filter((arg) => arg !== '--no-session');
    process.stderr.write('herdr-remote: ignoring removed --no-session argument (removed in Herdr 0.9.0)\n');
  }
  if (typeof config.herdr.socketPath !== 'string' || config.herdr.socketPath.length === 0) {
    config.herdr.socketPath = null;
  }
  if (typeof config.herdr.cwd !== 'string' || config.herdr.cwd.length === 0) {
    config.herdr.cwd = os.homedir();
  }

  // A "remote" config without a relay URL cannot reach anything; fall back to
  // local rather than silently starting a host connector that dials nowhere.
  if (config.relay.mode === 'remote' && !config.relay.remoteUrl) {
    config.relay.mode = 'local';
  }
  return config;
}

function applyEnvironment(config) {
  const env = process.env;
  if (env.HERDR_REMOTE_LANG && LANGUAGES.includes(env.HERDR_REMOTE_LANG)) config.ui.language = env.HERDR_REMOTE_LANG;
  if (env.HERDR_REMOTE_MODE && ACCESS_MODES.includes(env.HERDR_REMOTE_MODE)) config.relay.mode = env.HERDR_REMOTE_MODE;
  if (env.RELAY_PORT) config.relay.port = env.RELAY_PORT;
  if (env.RELAY_PUBLIC_URL) config.relay.publicUrl = env.RELAY_PUBLIC_URL;
  if (env.RELAY_REMOTE_URL) config.relay.remoteUrl = env.RELAY_REMOTE_URL;
  if (env.RELAY_MAX_HOSTS) config.relay.maxHosts = env.RELAY_MAX_HOSTS;
  if (env.RELAY_MAX_PENDING_HANDSHAKES) config.relay.maxPendingHandshakes = env.RELAY_MAX_PENDING_HANDSHAKES;
  if (env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT) config.relay.maxBufferedBytesPerClient = env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT;
  if (env.RELAY_HOST_RECONNECT_GRACE_MS) config.relay.hostReconnectGraceMs = env.RELAY_HOST_RECONNECT_GRACE_MS;
  if (env.HERDR_SOCKET_PATH) config.herdr.socketPath = env.HERDR_SOCKET_PATH;
  if (env.HERDR_CWD) config.herdr.cwd = env.HERDR_CWD;
  if (env.HERDR_ARGS_JSON) {
    try {
      const args = JSON.parse(env.HERDR_ARGS_JSON);
      if (Array.isArray(args)) config.herdr.args = args;
    } catch (error) {
      process.stderr.write(`herdr-remote: invalid HERDR_ARGS_JSON: ${error.message}\n`);
    }
  }
}

function loadConfig() {
  const fileConfig = readJson(configPath());
  const config = mergeConfig(fileConfig);
  normalizeLegacyFields(config, fileConfig);
  applyEnvironment(config);
  validate(config);
  return config;
}

function configExists() {
  return fs.existsSync(configPath());
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** Whether this machine runs its own relay process. */
function runsLocalRelay(config) {
  return config.relay.mode !== 'remote';
}

/** Address the local relay binds to for the configured mode. */
function bindAddress(config) {
  return config.relay.mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Host name to put into pairing URLs. For "lan" this is the interface address a
 * phone can actually reach; `lanHost` is the user's pick from the TUI, and the
 * fallback keeps things working if that interface disappeared.
 */
function advertisedHost(config, fallbackLanHost = null) {
  if (config.relay.mode === 'lan') {
    const configured = config.relay.lanHost;
    if (configured && !isLoopbackHost(configured) && !isUnspecifiedAddress(configured)) return configured;
    if (fallbackLanHost && !isLoopbackHost(fallbackLanHost) && !isUnspecifiedAddress(fallbackLanHost)) {
      return fallbackLanHost;
    }
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

/** The URL a browser opens. */
function resolvePublicUrl(config, fallbackLanHost = null) {
  if (config.relay.publicUrl) return config.relay.publicUrl;
  if (config.relay.mode === 'remote') return httpOrigin(config.relay.remoteUrl);
  return `http://${advertisedHost(config, fallbackLanHost)}:${config.relay.port}`;
}

/** Base HTTP origin used for relay admin calls (pairing, health). */
function resolveAdminOrigin(config) {
  if (config.relay.mode === 'remote') return httpOrigin(config.relay.remoteUrl);
  return `http://127.0.0.1:${config.relay.port}`;
}

/** WebSocket URL the host connector dials. */
function resolveHostRelayUrl(config) {
  const base = config.relay.mode === 'remote'
    ? config.relay.remoteUrl
    : `ws://127.0.0.1:${config.relay.port}`;
  return hostWebSocketUrl(base);
}

function httpOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return normalizeUrl(value);
  }
}

function hostWebSocketUrl(base) {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') {
    url.pathname = '/ws/host';
  } else if (!pathname.endsWith('/ws/host')) {
    url.pathname = `${pathname}/ws/host`;
  }
  return url.toString();
}

function clientWebSocketUrl(locationLike) {
  const url = new URL(locationLike);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = !pathname || pathname === '/' ? '/ws/client' : `${pathname}/ws/client`;
  return url.toString();
}

module.exports = {
  PACKAGE_ROOT,
  DEFAULTS,
  ACCESS_MODES,
  OFFICIAL_RELAY_URL,
  LANGUAGES,
  KEEPALIVE_MANAGERS,
  configDir,
  configPath,
  configExists,
  stateDir,
  runtimeStatePath,
  legacyConfigPath,
  migrateLegacyConfig,
  loadConfig,
  validate,
  runsLocalRelay,
  bindAddress,
  advertisedHost,
  resolvePublicUrl,
  resolveAdminOrigin,
  resolveHostRelayUrl,
  hostWebSocketUrl,
  clientWebSocketUrl,
  httpOrigin,
  isLoopbackHost,
  isUnspecifiedAddress,
  isUnspecifiedHost,
};
