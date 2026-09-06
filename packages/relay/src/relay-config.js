'use strict';

// Standalone relay configuration.
//
// The relay is deliberately decoupled from the herdr-remote plugin: it never
// reads the plugin's config directory and never imports plugin code. Settings
// come from (lowest to highest precedence) built-in defaults, an optional JSON
// config file, environment variables, then command line flags.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function defaultStateDir() {
  if (process.env.RELAY_STATE_DIR) return process.env.RELAY_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'herdr-remote-relay');
}

const DEFAULTS = {
  relay: {
    // A relay package is remote/operator-facing by default. The workstation
    // service sets this to local for the private relay it starts itself so the
    // web client can distinguish its own status page from the operator console.
    mode: 'remote',
    // Bind to loopback by default: the common production shape is a TLS
    // reverse proxy on the same machine. Containers and LAN deployments set
    // RELAY_BIND=0.0.0.0 explicitly.
    host: '127.0.0.1',
    port: 8787,
    publicUrl: 'http://127.0.0.1:8787',
    maxPayloadBytes: 1024 * 1024,
    maxClientsPerHost: 16,
    maxHosts: 1024,
    maxPendingHandshakes: 1024,
    maxBufferedBytesPerClient: 4 * 1024 * 1024,
    allowedOrigins: [],
    trustProxy: false,
    hostReconnectGraceMs: 30 * 1000,
  },
  auth: {
    pairingTtlMs: 10 * 60 * 1000,
    deviceTtlMs: 30 * 24 * 60 * 60 * 1000,
    maxDevices: 32,
    // Optional shared password. Unset means a public relay: anyone may connect
    // a workstation, and each one is still reachable only through its own host
    // token.
    password: null,
    // Optional operator credential for the standalone relay dashboard. This is
    // deliberately separate from the join password and from device tokens:
    // the former is shared with workstations, while the latter is scoped to a
    // single workstation.
    adminToken: null,
    stateFile: null,
  },
  cleanup: {
    intervalMs: 60 * 1000,
    heartbeatIntervalMs: 30 * 1000,
    staleAfterMs: 90 * 1000,
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read relay config ${filePath}: ${error.message}`);
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return fallback;
  return numeric;
}

function parseOriginList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== 'string') return null;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function mergeSection(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(target)) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

/**
 * Parse `--flag value` / `--flag=value` pairs plus the standalone flags the
 * relay binary understands. Returns { options, help, version, errors }.
 */
function parseArgv(argv = []) {
  const options = {};
  const errors = [];
  let help = false;
  let version = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--version' || arg === '-v') { version = true; continue; }
    if (!arg.startsWith('--')) { errors.push(`unexpected argument: ${arg}`); continue; }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    let value = equals === -1 ? undefined : arg.slice(equals + 1);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        // Bare boolean flag.
        value = 'true';
      } else {
        value = next;
        index += 1;
      }
    }
    options[name] = value;
  }
  return { options, help, version, errors };
}

function applyFile(config, fileConfig) {
  if (!fileConfig || typeof fileConfig !== 'object') return;
  mergeSection(config.relay, fileConfig.relay);
  mergeSection(config.auth, fileConfig.auth);
  mergeSection(config.cleanup, fileConfig.cleanup);
}

function applyEnvironment(config, env) {
  if (env.RELAY_DEPLOYMENT_MODE === 'local' || env.RELAY_DEPLOYMENT_MODE === 'remote') {
    config.relay.mode = env.RELAY_DEPLOYMENT_MODE;
  }
  if (env.RELAY_BIND) config.relay.host = env.RELAY_BIND;
  if (env.RELAY_PORT) config.relay.port = env.RELAY_PORT;
  if (env.RELAY_PUBLIC_URL) config.relay.publicUrl = env.RELAY_PUBLIC_URL;
  if (env.RELAY_MAX_PAYLOAD_BYTES) config.relay.maxPayloadBytes = env.RELAY_MAX_PAYLOAD_BYTES;
  if (env.RELAY_MAX_CLIENTS_PER_HOST) config.relay.maxClientsPerHost = env.RELAY_MAX_CLIENTS_PER_HOST;
  if (env.RELAY_MAX_HOSTS) config.relay.maxHosts = env.RELAY_MAX_HOSTS;
  if (env.RELAY_MAX_PENDING_HANDSHAKES) config.relay.maxPendingHandshakes = env.RELAY_MAX_PENDING_HANDSHAKES;
  if (env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT) config.relay.maxBufferedBytesPerClient = env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT;
  if (env.RELAY_HOST_RECONNECT_GRACE_MS) config.relay.hostReconnectGraceMs = env.RELAY_HOST_RECONNECT_GRACE_MS;
  if (env.RELAY_ALLOWED_ORIGINS !== undefined) {
    const origins = parseOriginList(env.RELAY_ALLOWED_ORIGINS);
    if (origins) config.relay.allowedOrigins = origins;
  }
  if (env.RELAY_TRUST_PROXY !== undefined) {
    config.relay.trustProxy = parseBoolean(env.RELAY_TRUST_PROXY, config.relay.trustProxy);
  }
  if (env.RELAY_PASSWORD) config.auth.password = env.RELAY_PASSWORD;
  if (env.RELAY_ADMIN_TOKEN) config.auth.adminToken = env.RELAY_ADMIN_TOKEN;
  if (env.RELAY_AUTH_STATE_FILE) config.auth.stateFile = env.RELAY_AUTH_STATE_FILE;
  if (env.RELAY_PAIRING_TTL_MS) config.auth.pairingTtlMs = env.RELAY_PAIRING_TTL_MS;
  if (env.RELAY_DEVICE_TTL_MS) config.auth.deviceTtlMs = env.RELAY_DEVICE_TTL_MS;
  if (env.RELAY_MAX_DEVICES) config.auth.maxDevices = env.RELAY_MAX_DEVICES;
}

function applyOptions(config, options) {
  if (options['deployment-mode'] === 'local' || options['deployment-mode'] === 'remote') {
    config.relay.mode = options['deployment-mode'];
  }
  if (options.bind) config.relay.host = options.bind;
  if (options.port) config.relay.port = options.port;
  if (options['public-url']) config.relay.publicUrl = options['public-url'];
  if (options['allowed-origins'] !== undefined) {
    const origins = parseOriginList(options['allowed-origins']);
    if (origins) config.relay.allowedOrigins = origins;
  }
  if (options['trust-proxy'] !== undefined) {
    config.relay.trustProxy = parseBoolean(options['trust-proxy'], config.relay.trustProxy);
  }
  if (options.password) config.auth.password = options.password;
  if (options['admin-token']) config.auth.adminToken = options['admin-token'];
  if (options['state-file']) config.auth.stateFile = options['state-file'];
  if (options['max-clients']) config.relay.maxClientsPerHost = options['max-clients'];
  if (options['max-hosts']) config.relay.maxHosts = options['max-hosts'];
  if (options['max-pending-handshakes']) config.relay.maxPendingHandshakes = options['max-pending-handshakes'];
  if (options['max-buffered-bytes']) config.relay.maxBufferedBytesPerClient = options['max-buffered-bytes'];
  if (options['host-reconnect-grace-ms']) config.relay.hostReconnectGraceMs = options['host-reconnect-grace-ms'];
}

function validate(config) {
  if (config.relay.mode !== 'local' && config.relay.mode !== 'remote') config.relay.mode = DEFAULTS.relay.mode;
  config.relay.port = parseInteger(config.relay.port, DEFAULTS.relay.port, 0, 65535);
  config.relay.maxPayloadBytes = parseInteger(
    config.relay.maxPayloadBytes,
    DEFAULTS.relay.maxPayloadBytes,
    4096,
    16 * 1024 * 1024,
  );
  config.relay.maxClientsPerHost = parseInteger(config.relay.maxClientsPerHost, DEFAULTS.relay.maxClientsPerHost, 1, 256);
  config.relay.maxHosts = parseInteger(config.relay.maxHosts, DEFAULTS.relay.maxHosts, 1, 100000);
  config.relay.maxPendingHandshakes = parseInteger(
    config.relay.maxPendingHandshakes,
    DEFAULTS.relay.maxPendingHandshakes,
    16,
    100000,
  );
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
  config.cleanup.heartbeatIntervalMs = parseInteger(
    config.cleanup.heartbeatIntervalMs,
    DEFAULTS.cleanup.heartbeatIntervalMs,
    1000,
    10 * 60 * 1000,
  );
  config.cleanup.staleAfterMs = parseInteger(
    config.cleanup.staleAfterMs,
    DEFAULTS.cleanup.staleAfterMs,
    config.cleanup.heartbeatIntervalMs * 2,
    24 * 60 * 60 * 1000,
  );

  if (typeof config.relay.host !== 'string' || config.relay.host.length === 0) {
    config.relay.host = DEFAULTS.relay.host;
  }
  if (typeof config.relay.publicUrl !== 'string' || config.relay.publicUrl.length === 0) {
    config.relay.publicUrl = `http://${config.relay.host}:${config.relay.port}`;
  }
  config.relay.publicUrl = String(config.relay.publicUrl).replace(/\/+$/, '');
  if (!Array.isArray(config.relay.allowedOrigins)) config.relay.allowedOrigins = [];
  config.relay.trustProxy = parseBoolean(config.relay.trustProxy, false);
  if (!config.auth.stateFile) {
    config.auth.stateFile = path.join(defaultStateDir(), 'relay-auth.json');
  }
  return config;
}

/**
 * Warnings a standalone operator should see at startup. These are advisory —
 * the relay still starts, because a loopback-only development run legitimately
 * needs neither TLS nor tokens.
 */
function configWarnings(config) {
  const warnings = [];
  const isLoopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(config.relay.host);
  let publicUrl;
  try {
    publicUrl = new URL(config.relay.publicUrl);
  } catch {
    warnings.push(`publicUrl is not a valid URL: ${config.relay.publicUrl}`);
  }
  if (!config.auth.password) {
    warnings.push('no password set (RELAY_PASSWORD): this is a public relay, anyone may connect a workstation to it');
  }
  if (config.relay.mode === 'remote' && !config.auth.adminToken) {
    warnings.push('no admin token set (RELAY_ADMIN_TOKEN): the relay operator dashboard is unavailable');
  }
  if (!isLoopbackBind && publicUrl && publicUrl.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(publicUrl.hostname)) {
    warnings.push(`publicUrl uses plain http on a non-loopback address (${config.relay.publicUrl}); terminate TLS in front of the relay`);
  }
  return warnings;
}

function loadRelayConfig({ argv = [], env = process.env } = {}) {
  const { options, help, version, errors } = parseArgv(argv);
  const config = clone(DEFAULTS);

  const configFile = options.config || env.HERDR_RELAY_CONFIG || null;
  if (configFile) {
    const fileConfig = readJsonFile(path.resolve(configFile));
    if (fileConfig === null) throw new Error(`relay config not found: ${configFile}`);
    applyFile(config, fileConfig);
  }
  applyEnvironment(config, env);
  applyOptions(config, options);
  validate(config);

  return { config, help, version, errors, configFile, warnings: configWarnings(config) };
}

module.exports = {
  PACKAGE_ROOT,
  DEFAULTS,
  loadRelayConfig,
  parseArgv,
  validate,
  configWarnings,
  defaultStateDir,
};
