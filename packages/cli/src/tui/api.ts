// The only place the TUI reaches into the service layer.
//
// Everything below the interface — config, services, keep-alive, pairing — is
// shared with the CLI. Funnelling it through one module gives the screens a
// single surface to call.

import { OFFICIAL_RELAY_URL, configExists, loadConfig } from '../config.js';
import { configPath, stateDir } from '../paths.js';
import { bindAddress, resolveAdminOrigin } from '../relay-urls.js';
import { MIN_HERDR_VERSION, herdrVersion } from '../herdr-command.js';
import { createTranslator, detectLocale } from '../i18n/index.js';
import { listReachableAddresses } from '../net-interfaces.js';
import {
  createDraft,
  fieldsForMode,
  getField,
  getFieldPlaceholder,
  isOfficialRelay,
  requiresRestart,
  saveDraft,
  selectedMode,
  setField,
} from '../settings-model.js';
import { extractPairingCode, requestJson } from '../relay-client.js';
import { ensureRuntime, regenerateHostIdentity, setRelayPassword } from '../runtime.js';
import { pair, readLogTail } from '../service.js';
import { fullStatus, restartAll, startAll, stopAll } from '../lifecycle.js';
import * as keepalive from '../keepalive/index.js';
import {
  canSelfUpdate,
  checkForUpdate,
  currentVersion,
  updateChecksEnabled,
  installKind,
  performUpdate,
} from '../updater.js';

import type { AccessMode, Config } from '../config.js';

export type { AccessMode, Config };
export type { Locale } from '../i18n/index.js';
export type { NetworkAddress } from '../net-interfaces.js';
/** Screens only call `t(key, values)`; the full Translate type lives in i18n. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

import type { KeepaliveStatus } from '../keepalive/index.js';

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
    health: {
      ok?: boolean;
      message?: string;
      hosts?: number;
      clients?: number;
      version?: string;
      uptimeSeconds?: number;
    } | null;
  };
  host: {
    pid: number | null;
    alive: boolean;
    hostId: string | null;
    socketPath: string;
    socketExists: boolean;
  };
  publicUrl: string;
  startedAt: string | null;
  keepalive: KeepaliveStatus;
  logsHint: string;
};

export type Pairing = { code: string; pairUrl: string; expiresAt: number; hostId: string };

export type { UpdateCheck } from '../updater.js';

export {
  detectLocale,
  listReachableAddresses,
  MIN_HERDR_VERSION,
  OFFICIAL_RELAY_URL,
  isOfficialRelay,
  selectedMode,
  canSelfUpdate,
  checkForUpdate,
  currentVersion,
  updateChecksEnabled,
  installKind,
  performUpdate,
  bindAddress,
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
  herdrVersion,
  keepalive,
  loadConfig,
  pair,
  readLogTail,
  regenerateHostIdentity,
  requiresRestart,
  restartAll,
  saveDraft,
  setField,
  setRelayPassword,
  startAll,
  stateDir,
  stopAll,
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

/**
 * Reachability probe used by the relay screen, for local and remote alike.
 *
 * Liveness and tenant status are deliberately separate: a relay must be able
 * to report "I am reachable" before this workstation has enrolled, while the
 * host count (when available) comes only from this workstation's scoped view.
 */
export async function probeRelay(
  config: Config,
): Promise<{ ok: boolean; version?: string; hosts?: number; message?: string }> {
  const origin = resolveAdminOrigin(config);
  let health: Record<string, unknown>;
  try {
    health = await requestJson(`${origin}/healthz`, { timeout: 4000 });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  try {
    const runtime = ensureRuntime();
    const status = await requestJson(`${origin}/api/status`, {
      timeout: 4000,
      headers: {
        'X-Herdr-Host-Id': runtime.hostId,
        'X-Herdr-Host-Token': runtime.hostToken,
      },
    });
    return {
      ok: true,
      version: String(health.version || status.version || ''),
      hosts: Array.isArray(status.hosts) ? status.hosts.length : 0,
    };
  } catch {
    // The relay is healthy even when this machine is not enrolled or its host
    // connector is offline. Do not turn a tenant-auth failure into a network
    // failure in the configuration TUI.
    return { ok: true, version: String(health.version || ''), hosts: undefined };
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
