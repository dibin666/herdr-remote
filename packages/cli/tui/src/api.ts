// The only place the TUI reaches into the CommonJS service layer.
//
// Everything below the interface — config, services, keep-alive, pairing — is
// plain Node modules shared with the CLI. Funnelling them through one module
// keeps the React code free of require paths and gives the screens a single,
// typed surface to call.

import {
  ACCESS_MODES,
  OFFICIAL_RELAY_URL,
  bindAddress,
  configExists,
  configPath,
  loadConfig,
  resolveAdminOrigin,
  resolvePublicUrl,
  stateDir,
} from '../../src/config.js';
import { createTranslator, detectLocale as detectLocaleRaw } from '../../src/i18n/index.js';
import { listReachableAddresses as listReachableAddressesRaw, preferredLanAddress } from '../../src/net-interfaces.js';
import {
  FIELDS,
  createDraft,
  fieldsForMode,
  getField,
  getFieldPlaceholder,
  requiresRestart,
  saveDraft,
  setField,
  validateDraft,
} from '../../src/settings-model.js';
import {
  ensureRuntime,
  extractPairingCode,
  pair,
  readLogTail,
  readRuntime,
  regenerateHostIdentity,
  requestJson,
  setRelayPassword,
} from '../../src/service.js';
import { fullStatus, restartAll, startAll, stopAll } from '../../src/lifecycle.js';
import * as keepalive from '../../src/keepalive.js';
import * as herdrPlugin from '../../src/herdr-plugin.js';
import {
  canSelfUpdate,
  checkForUpdate,
  installKind,
  performUpdate,
} from '../../src/updater.js';

export type AccessMode = 'local' | 'lan' | 'remote';
export type Locale = 'en' | 'zh';
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export type Config = {
  ui: { language: 'auto' | Locale };
  relay: {
    mode: AccessMode;
    port: number;
    lanHost: string;
    publicUrl: string;
    remoteUrl: string;
    maxClientsPerHost: number;
    allowedOrigins: string[];
  };
  herdr: { socketPath: string | null; args: string[]; cwd: string };
  auth: { pairingTtlMs: number; deviceTtlMs: number; maxDevices: number };
  keepalive: { manager: string };
};

export type KeepaliveStatus = {
  manager: string;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  linger?: boolean;
  pid?: number | null;
  unitPath?: string;
  state?: string;
};

export type Status = {
  ok: boolean;
  mode: AccessMode;
  relay: {
    local: boolean;
    pid: number | null;
    alive: boolean | null;
    bind: string | null;
    port: number;
    remoteUrl: string | null;
    health: { ok?: boolean; message?: string; hosts?: number; clients?: number; version?: string; uptimeSeconds?: number } | null;
  };
  host: { pid: number | null; alive: boolean; hostId: string | null; socketPath: string; socketExists: boolean };
  publicUrl: string;
  startedAt: string | null;
  keepalive: KeepaliveStatus;
  logsHint: string;
};

export type Pairing = { code: string; pairUrl: string; expiresAt: number; hostId: string };

export type NetworkAddress = {
  name: string;
  address: string;
  family: string;
  kind: 'tailscale' | 'lan' | 'virtual' | 'loopback';
  internal: boolean;
};

export type LifecycleResult = { ok?: boolean; managed: boolean; manager?: string };

/**
 * Typed wrappers over the untyped CommonJS layer. TypeScript infers `string`
 * for these returns, which would let a typo in an interface kind or a locale
 * through; narrowing here keeps that check at the one boundary rather than at
 * every call site.
 */
export function detectLocale(options: { preference?: string; env?: NodeJS.ProcessEnv } = {}): Locale {
  return detectLocaleRaw(options) as Locale;
}

export function listReachableAddresses(options: { includeLoopback?: boolean; includeIpv6?: boolean } = {}): NetworkAddress[] {
  return listReachableAddressesRaw(options) as NetworkAddress[];
}

export {
  ACCESS_MODES,
  OFFICIAL_RELAY_URL,
  canSelfUpdate,
  checkForUpdate,
  installKind,
  performUpdate,
  bindAddress,
  FIELDS,
  configExists,
  configPath,
  createDraft,
  createTranslator,
  ensureRuntime,
  extractPairingCode,
  fieldsForMode,
  fullStatus,
  getField,
  getFieldPlaceholder,
  herdrPlugin,
  keepalive,
  loadConfig,
  pair,
  preferredLanAddress,
  readLogTail,
  readRuntime,
  regenerateHostIdentity,
  requestJson,
  requiresRestart,
  resolveAdminOrigin,
  resolvePublicUrl,
  restartAll,
  saveDraft,
  setField,
  setRelayPassword,
  startAll,
  stateDir,
  stopAll,
  validateDraft,
};

/** The command that starts a matching relay, ready to paste on the server. */
export function relayStartCommand(config: Config, password: string): string {
  const publicUrl = config.relay.remoteUrl
    ? config.relay.remoteUrl.replace(/^ws/, 'http')
    : 'https://relay.example.com';
  const parts = ['herdr-remote-relay', `--public-url ${publicUrl}`, '--trust-proxy'];
  if (password) parts.push(`--password '${password.replace(/'/g, "'\\''")}'`);
  return parts.join(' ');
}

/** Reachability probe used by the relay screen, for local and remote alike. */
export async function probeRelay(config: Config): Promise<{ ok: boolean; version?: string; hosts?: number; message?: string }> {
  try {
    const health = await requestJson(`${resolveAdminOrigin(config)}/healthz`, { timeout: 4000 });
    return { ok: true, version: health.version, hosts: health.hosts };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export function formatUptime(seconds: number | undefined, t: Translate): string {
  if (!Number.isFinite(seconds as number)) return t('common.unknown');
  const total = Math.max(0, Math.floor(seconds as number));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
