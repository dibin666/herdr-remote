// The configuration file: its shape, its defaults, and how a file on disk,
// older schemas and the environment become one validated Config.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS as RELAY_DEFAULTS } from 'herdr-remote-relay/config';
import { configPath, legacyConfigPath } from './paths.js';
import {
  isLoopbackHost,
  isUnspecifiedAddress,
  isUnspecifiedHost,
  normalizeUrl,
} from './relay-urls.js';

// Access modes
//   local  — a relay runs on this machine, reachable only from this machine.
//   lan    — a relay runs on this machine, bound to every interface so other
//            devices on the LAN (or on a Tailscale/WireGuard overlay) reach it.
//   remote — no local relay; the host connector dials an operator-run relay,
//            which is the only way in from outside the local network.
const ACCESS_MODES = ['local', 'lan', 'remote'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

// The relay this project runs for people who do not want to host one. Offered
// as a one-keystroke choice during setup; it is never selected automatically,
// because routing a terminal through someone else's server has to be a
// deliberate decision. It is a plain public relay: no join password, and each
// workstation stays reachable only through its own host token.
const OFFICIAL_RELAY_URL = 'wss://herdr-remote.564616.xyz';
const LANGUAGES = ['auto', 'zh', 'en'] as const;
type LanguagePreference = (typeof LANGUAGES)[number];
const KEEPALIVE_MANAGERS = ['auto', 'systemd', 'launchd', 'supervisor', 'none'] as const;
export type KeepaliveManager = (typeof KEEPALIVE_MANAGERS)[number];

/** A configuration after `validate`: every field present and in range. */
export interface Config {
  ui: { language: LanguagePreference };
  relay: {
    mode: AccessMode;
    port: number;
    lanHost: string;
    publicUrl: string;
    remoteUrl: string;
    maxPayloadBytes: number;
    maxClientsPerHost: number;
    maxHosts: number;
    maxPendingHandshakes: number;
    maxBufferedBytesPerClient: number;
    hostReconnectGraceMs: number;
    allowedOrigins: string[];
  };
  herdr: { socketPath: string | null; args: string[]; cwd: string; autoStart: boolean };
  auth: { pairingTtlMs: number; deviceTtlMs: number; maxDevices: number };
  cleanup: { intervalMs: number; heartbeatIntervalMs: number; staleAfterMs: number };
  keepalive: { manager: KeepaliveManager };
}

/**
 * A configuration while it is being assembled: the file and the environment
 * may put anything where `validate` expects a number or a list.
 */
type ConfigDraft = { [Section in keyof Config]: Record<string, unknown> };

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

const DEFAULTS: Config = {
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
    // The CLI starts a relay of its own, so its limits are the relay
    // package's: a smaller ceiling here would reject an upload the hosted
    // relay accepts.
    maxPayloadBytes: RELAY_DEFAULTS.relay.maxPayloadBytes,
    maxClientsPerHost: RELAY_DEFAULTS.relay.maxClientsPerHost,
    maxHosts: RELAY_DEFAULTS.relay.maxHosts,
    maxPendingHandshakes: RELAY_DEFAULTS.relay.maxPendingHandshakes,
    maxBufferedBytesPerClient: RELAY_DEFAULTS.relay.maxBufferedBytesPerClient,
    hostReconnectGraceMs: RELAY_DEFAULTS.relay.hostReconnectGraceMs,
    allowedOrigins: [],
  },
  herdr: {
    socketPath: null,
    args: [],
    cwd: os.homedir(),
    // Start Herdr's server when herdr-remote starts (at boot, under keep-alive).
    // Off: Herdr starts when the user runs it, or confirms it from the WebUI.
    autoStart: false,
  },
  auth: {
    pairingTtlMs: RELAY_DEFAULTS.auth.pairingTtlMs,
    deviceTtlMs: RELAY_DEFAULTS.auth.deviceTtlMs,
    maxDevices: RELAY_DEFAULTS.auth.maxDevices,
  },
  cleanup: { ...RELAY_DEFAULTS.cleanup },
  keepalive: {
    manager: 'auto',
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT') {
      process.stderr.write(`herdr-remote: ignoring invalid JSON at ${filePath}: ${message}\n`);
    }
    return {};
  }
}

/**
 * Copy a config written by an older, plugin-scoped install into the canonical
 * location. Runs at most once: it never overwrites an existing config.
 */
function migrateLegacyConfig():
  | { migrated: true; from: string; to: string }
  | { migrated: false; reason: string } {
  const target = configPath();
  if (fs.existsSync(target)) return { migrated: false, reason: 'config already exists' };
  const legacy = legacyConfigPath();
  if (!legacy || !fs.existsSync(legacy)) return { migrated: false, reason: 'no legacy config' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(legacy, target);
    return { migrated: true, from: legacy, to: target };
  } catch (error) {
    return { migrated: false, reason: (error as Error).message };
  }
}

function mergeConfig(fileConfig: unknown): ConfigDraft {
  const config = clone(DEFAULTS) as unknown as ConfigDraft;
  const file = (fileConfig ?? {}) as Partial<Record<keyof Config, unknown>>;
  for (const section of Object.keys(config) as (keyof Config)[]) {
    const values = file[section];
    if (values && typeof values === 'object') Object.assign(config[section], values);
  }
  return config;
}

/**
 * Accept configs written before access modes existed. The 0.1 schema used
 * `relay.local` (boolean), `relay.host` (bind address) and `relay.url`.
 */
function normalizeLegacyFields(config: ConfigDraft, fileConfig: unknown): void {
  const legacy: Record<string, unknown> =
    ((fileConfig as { relay?: Record<string, unknown> } | null)?.relay as Record<
      string,
      unknown
    >) || {};
  // The absence of an explicit `mode` — not an invalid one — is what marks a
  // file as pre-0.2, since merging defaults always leaves a valid mode behind.
  const hasExplicitMode = isOneOf(ACCESS_MODES, legacy.mode);
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
  if (
    config.relay.mode === 'lan' &&
    !config.relay.lanHost &&
    typeof legacy.host === 'string' &&
    !isLoopbackHost(legacy.host) &&
    legacy.host !== '0.0.0.0'
  ) {
    config.relay.lanHost = legacy.host;
  }
  // Superseded keys copied in by the merge would otherwise reappear in the
  // in-memory config and confuse anything reading it.
  delete config.relay.local;
  delete config.relay.host;
  delete config.relay.url;
  // `publicUrl` used to be mandatory and defaulted to the loopback URL; treat
  // that default as "no override" so derivation can take over.
  if (
    typeof config.relay.publicUrl === 'string' &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(config.relay.publicUrl)
  ) {
    config.relay.publicUrl = '';
  }
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return fallback;
  return numeric;
}

function validate(config: ConfigDraft): Config {
  if (!isOneOf(ACCESS_MODES, config.relay.mode)) config.relay.mode = DEFAULTS.relay.mode;
  if (!isOneOf(LANGUAGES, config.ui.language)) config.ui.language = DEFAULTS.ui.language;
  if (!isOneOf(KEEPALIVE_MANAGERS, config.keepalive.manager))
    config.keepalive.manager = DEFAULTS.keepalive.manager;

  config.relay.port = parseInteger(config.relay.port, DEFAULTS.relay.port, 1, 65535);
  config.relay.maxPayloadBytes = parseInteger(
    config.relay.maxPayloadBytes,
    DEFAULTS.relay.maxPayloadBytes,
    4096,
    16 * 1024 * 1024,
  );
  config.relay.maxClientsPerHost = parseInteger(
    config.relay.maxClientsPerHost,
    DEFAULTS.relay.maxClientsPerHost,
    1,
    256,
  );
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
  config.auth.pairingTtlMs = parseInteger(
    config.auth.pairingTtlMs,
    DEFAULTS.auth.pairingTtlMs,
    30 * 1000,
    24 * 60 * 60 * 1000,
  );
  config.auth.deviceTtlMs = parseInteger(
    config.auth.deviceTtlMs,
    DEFAULTS.auth.deviceTtlMs,
    60 * 1000,
    365 * 24 * 60 * 60 * 1000,
  );
  config.auth.maxDevices = parseInteger(config.auth.maxDevices, DEFAULTS.auth.maxDevices, 1, 10000);
  config.cleanup.intervalMs = parseInteger(
    config.cleanup.intervalMs,
    DEFAULTS.cleanup.intervalMs,
    1000,
    24 * 60 * 60 * 1000,
  );
  config.cleanup.heartbeatIntervalMs = parseInteger(
    config.cleanup.heartbeatIntervalMs,
    DEFAULTS.cleanup.heartbeatIntervalMs,
    1000,
    10 * 60 * 1000,
  );
  config.cleanup.staleAfterMs = parseInteger(
    config.cleanup.staleAfterMs,
    DEFAULTS.cleanup.staleAfterMs,
    (config.cleanup.heartbeatIntervalMs as number) * 2,
    24 * 60 * 60 * 1000,
  );

  config.relay.publicUrl = normalizeUrl(config.relay.publicUrl);
  config.relay.remoteUrl = normalizeUrl(config.relay.remoteUrl);
  config.relay.lanHost =
    typeof config.relay.lanHost === 'string' ? config.relay.lanHost.trim() : '';
  // A LAN relay listens on every interface, but a loopback or wildcard value
  // cannot be opened by another device. Clear stale values from older TUI
  // versions so the advertised URL falls back to a real interface address.
  if (
    config.relay.mode === 'lan' &&
    (isLoopbackHost(config.relay.lanHost) || isUnspecifiedAddress(config.relay.lanHost))
  ) {
    config.relay.lanHost = '';
  }
  // 0.0.0.0 is a server-side bind wildcard, never a destination a browser can
  // open. Treat it like an empty override so LAN mode derives the real address.
  if (isUnspecifiedHost(config.relay.publicUrl as string)) config.relay.publicUrl = '';
  if (!Array.isArray(config.relay.allowedOrigins)) config.relay.allowedOrigins = [];

  if (
    !Array.isArray(config.herdr.args) ||
    !config.herdr.args.every((arg) => typeof arg === 'string')
  ) {
    config.herdr.args = [];
  }
  const args = config.herdr.args as string[];
  // Herdr 0.9.0 removed --no-session; retaining it in saved configs causes
  // session creation to fail. Filter it out if present.
  if (args.includes('--no-session')) {
    config.herdr.args = args.filter((arg) => arg !== '--no-session');
    process.stderr.write(
      'herdr-remote: ignoring removed --no-session argument (removed in Herdr 0.9.0)\n',
    );
  }
  if (typeof config.herdr.socketPath !== 'string' || config.herdr.socketPath.length === 0) {
    config.herdr.socketPath = null;
  }
  if (typeof config.herdr.cwd !== 'string' || config.herdr.cwd.length === 0) {
    config.herdr.cwd = os.homedir();
  }
  config.herdr.autoStart = config.herdr.autoStart === true;

  // A "remote" config without a relay URL cannot reach anything; fall back to
  // local rather than silently starting a host connector that dials nowhere.
  if (config.relay.mode === 'remote' && !config.relay.remoteUrl) {
    config.relay.mode = 'local';
  }
  // Every field `Config` promises has been normalised above.
  return config as unknown as Config;
}

function applyEnvironment(config: ConfigDraft): void {
  const env = process.env;
  if (env.HERDR_REMOTE_LANG && isOneOf(LANGUAGES, env.HERDR_REMOTE_LANG))
    config.ui.language = env.HERDR_REMOTE_LANG;
  if (env.HERDR_REMOTE_MODE && isOneOf(ACCESS_MODES, env.HERDR_REMOTE_MODE))
    config.relay.mode = env.HERDR_REMOTE_MODE;
  if (env.RELAY_PORT) config.relay.port = env.RELAY_PORT;
  if (env.RELAY_PUBLIC_URL) config.relay.publicUrl = env.RELAY_PUBLIC_URL;
  if (env.RELAY_REMOTE_URL) config.relay.remoteUrl = env.RELAY_REMOTE_URL;
  if (env.RELAY_MAX_HOSTS) config.relay.maxHosts = env.RELAY_MAX_HOSTS;
  if (env.RELAY_MAX_PENDING_HANDSHAKES)
    config.relay.maxPendingHandshakes = env.RELAY_MAX_PENDING_HANDSHAKES;
  if (env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT)
    config.relay.maxBufferedBytesPerClient = env.RELAY_MAX_BUFFERED_BYTES_PER_CLIENT;
  if (env.RELAY_HOST_RECONNECT_GRACE_MS)
    config.relay.hostReconnectGraceMs = env.RELAY_HOST_RECONNECT_GRACE_MS;
  if (env.HERDR_SOCKET_PATH) config.herdr.socketPath = env.HERDR_SOCKET_PATH;
  if (env.HERDR_CWD) config.herdr.cwd = env.HERDR_CWD;
  if (env.HERDR_ARGS_JSON) {
    try {
      const args = JSON.parse(env.HERDR_ARGS_JSON);
      if (Array.isArray(args)) config.herdr.args = args;
    } catch (error) {
      process.stderr.write(`herdr-remote: invalid HERDR_ARGS_JSON: ${(error as Error).message}\n`);
    }
  }
}

function loadConfig(): Config {
  const fileConfig = readJson(configPath());
  const draft = mergeConfig(fileConfig);
  normalizeLegacyFields(draft, fileConfig);
  applyEnvironment(draft);
  return validate(draft);
}

function configExists(): boolean {
  return fs.existsSync(configPath());
}

export {
  DEFAULTS,
  ACCESS_MODES,
  OFFICIAL_RELAY_URL,
  LANGUAGES,
  KEEPALIVE_MANAGERS,
  configExists,
  migrateLegacyConfig,
  loadConfig,
  validate,
};
