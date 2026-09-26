// The relay's HTTP API as the dashboard uses it: where a profile's relay
// answers, what it says about itself, its status, and revoking a device.

import type { AdminStatusResponse, RelayInfoResponse } from '@protocol/http';

/** Resolve the active profile's relay origin without performing discovery. */
export function relayHttpBase(wsUrl: string): string {
  if (typeof window === 'undefined' || !wsUrl || wsUrl.startsWith('/')) return '';
  try {
    const url = new URL(wsUrl.replace(/^ws/, 'http'));
    const pathname = url.pathname.replace(/\/ws\/client\/?$/, '').replace(/\/+$/, '');
    // Keep the existing same-origin relative fetch contract. Absolute URLs are
    // needed only when a profile points at another relay origin.
    if (url.origin === window.location.origin && !pathname) return '';
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

export function relayEndpoint(wsUrl: string, endpoint: string): string {
  const base = relayHttpBase(wsUrl);
  if (!base) return endpoint;
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

/** GET /api/info; a relay too old to have it is described from its URL instead. */
export async function loadRelayInfo(wsUrl: string): Promise<RelayInfoResponse> {
  try {
    const res = await fetch(relayEndpoint(wsUrl, '/api/info'), {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) return (await res.json()) as RelayInfoResponse;
  } catch {
    // Fallback for legacy local servers without /api/info
  }
  const isRemoteUrl = Boolean(
    wsUrl &&
      !wsUrl.startsWith('/') &&
      !wsUrl.includes('localhost') &&
      !wsUrl.includes('127.0.0.1') &&
      typeof window !== 'undefined' &&
      !wsUrl.startsWith(window.location.origin.replace('http', 'ws')),
  );
  return {
    ok: true,
    version: '0.1.0',
    protocol: 1,
    relayMode: isRemoteUrl ? 'remote' : 'local',
    adminConfigured: false,
    adminPath: '/admin',
    adminStatusPath: '/api/admin/status',
  };
}

export type StatusResult =
  | { kind: 'ok'; data: AdminStatusResponse }
  | { kind: 'denied'; status: number };

/** GET a status endpoint. A refusal is an answer; anything else unexpected throws. */
export async function requestStatus(
  url: string,
  headers: Record<string, string>,
): Promise<StatusResult> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (res.status === 401 || res.status === 403) return { kind: 'denied', status: res.status };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return { kind: 'ok', data: (await res.json()) as AdminStatusResponse };
}

/**
 * Revoke a paired device. The relay drops the stored token hash and closes
 * whatever sockets it still holds.
 */
export async function requestDeviceRevoke(
  wsUrl: string,
  adminToken: string,
  deviceId: string,
): Promise<boolean> {
  const res = await fetch(
    relayEndpoint(wsUrl, `/api/admin/devices/${encodeURIComponent(deviceId)}`),
    {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-Relay-Admin-Token': adminToken },
    },
  );
  return res.ok;
}

/** Where a remote relay's own dashboard is. */
export function remoteAdminUrl(
  relayInfo: RelayInfoResponse | null,
  data: AdminStatusResponse | null,
  wsUrl: string,
): string {
  if (relayInfo?.adminPath) {
    if (relayInfo.publicUrl) {
      return `${relayInfo.publicUrl.replace(/\/$/, '')}${relayInfo.adminPath}`;
    }
    return relayEndpoint(wsUrl, relayInfo.adminPath);
  }
  if (data?.remoteAdminUrl) return data.remoteAdminUrl;
  if (wsUrl) return relayEndpoint(wsUrl, '/admin');
  return '/admin';
}
