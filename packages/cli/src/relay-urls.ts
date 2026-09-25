// The addresses a configuration implies: where the local relay binds, the URL
// a browser opens, and the relay URLs the host connector and the CLI dial.

import { WS_HOST_PATH } from 'herdr-remote-relay/protocol';
import type { Config } from './config.js';

function isLoopbackHost(value: unknown): boolean {
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

function isUnspecifiedAddress(value: unknown): boolean {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return address === '0.0.0.0' || address === '::' || address === '[::]';
}

/** An unspecified host is valid for a server bind, but not for a browser URL. */
function isUnspecifiedHost(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]';
  } catch {
    return false;
  }
}

function normalizeUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/** Whether this machine runs its own relay process. */
function runsLocalRelay(config: Config): boolean {
  return config.relay.mode !== 'remote';
}

/** Address the local relay binds to for the configured mode. */
function bindAddress(config: Config): string {
  return config.relay.mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Host name to put into pairing URLs. For "lan" this is the interface address a
 * phone can actually reach; `lanHost` is the user's pick from the TUI, and the
 * fallback keeps things working if that interface disappeared.
 */
function advertisedHost(config: Config, fallbackLanHost: string | null = null): string {
  if (config.relay.mode === 'lan') {
    const configured = config.relay.lanHost;
    if (configured && !isLoopbackHost(configured) && !isUnspecifiedAddress(configured))
      return configured;
    if (
      fallbackLanHost &&
      !isLoopbackHost(fallbackLanHost) &&
      !isUnspecifiedAddress(fallbackLanHost)
    ) {
      return fallbackLanHost;
    }
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

/** The URL a browser opens. */
function resolvePublicUrl(config: Config, fallbackLanHost: string | null = null): string {
  if (config.relay.publicUrl) return config.relay.publicUrl;
  if (config.relay.mode === 'remote') return httpOrigin(config.relay.remoteUrl);
  return `http://${advertisedHost(config, fallbackLanHost)}:${config.relay.port}`;
}

/** Base HTTP origin used for relay admin calls (pairing, health). */
function resolveAdminOrigin(config: Config): string {
  if (config.relay.mode === 'remote') return httpOrigin(config.relay.remoteUrl);
  return `http://127.0.0.1:${config.relay.port}`;
}

/** WebSocket URL the host connector dials. */
function resolveHostRelayUrl(config: Config): string {
  const base =
    config.relay.mode === 'remote' ? config.relay.remoteUrl : `ws://127.0.0.1:${config.relay.port}`;
  return hostWebSocketUrl(base);
}

function httpOrigin(value: string): string {
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

function hostWebSocketUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') {
    url.pathname = WS_HOST_PATH;
  } else if (!pathname.endsWith(WS_HOST_PATH)) {
    url.pathname = `${pathname}${WS_HOST_PATH}`;
  }
  return url.toString();
}

export {
  isLoopbackHost,
  isUnspecifiedAddress,
  isUnspecifiedHost,
  normalizeUrl,
  runsLocalRelay,
  bindAddress,
  advertisedHost,
  resolvePublicUrl,
  resolveAdminOrigin,
  resolveHostRelayUrl,
  httpOrigin,
  hostWebSocketUrl,
};
