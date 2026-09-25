// A window's PTY session on its host, and taking windows and hosts off the
// relay: detaching, host hand-off and the reconnect grace period.

import { WebSocket } from 'ws';
import { closeSocket, isOpen, jsonSend, randomId, terminateSocket } from './sockets.js';
import { broadcastToClients, notifyHostClientCount } from './transport.js';
import type { RelayClient, RelayContext, RelayHost } from './types.js';

/** Never shrink an individual session grid below something a program can still draw in. */
export const MIN_SESSION_COLS = 20;
export const MIN_SESSION_ROWS = 6;

export interface DetachOptions {
  /** Tell the window why, before closing it. */
  notify?: boolean;
  reason?: string;
  closeCode?: number;
  /** Drop the socket at once instead of closing it politely. */
  terminate?: boolean;
}

export function allocateStreamIndex(host: RelayHost | null | undefined): number | null {
  if (!host) return null;
  const totalPossible = 65536;
  for (let i = 0; i < totalPossible; i++) {
    const candidate = host.nextStreamIndex;
    host.nextStreamIndex = (host.nextStreamIndex + 1) & 0xffff;
    if (!host.streamIndices.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Forget `client`'s stream: its id, its v2 index on `host`, and the session itself. */
export function releaseSession(
  relay: RelayContext,
  host: RelayHost | null | undefined,
  client: RelayClient,
): void {
  const session = client.session;
  if (!session) return;
  if (session.streamIndex !== null && session.streamIndex !== undefined && host) {
    host.streamIndices.delete(session.streamIndex);
  }
  relay.streams.delete(session.streamId);
  client.session = null;
}

/** Start a dedicated PTY session for one attached client. */
export function startSession(
  relay: RelayContext,
  host: RelayHost,
  client: RelayClient | null | undefined,
  { restarted = false } = {},
): void {
  if (!client || !isOpen(host.ws)) return;
  const streamId = randomId('session');
  let streamIndex: number | null = null;
  if (host.binaryFrameV2) {
    streamIndex = allocateStreamIndex(host);
    if (streamIndex !== null) {
      host.streamIndices.set(streamIndex, client.id);
    }
  }
  client.session = {
    streamId,
    streamIndex,
    cols: client.cols,
    rows: client.rows,
    ready: false,
  };
  relay.streams.set(streamId, client.id);
  jsonSend(host.ws, {
    type: 'session_start',
    clientId: streamId,
    streamId,
    cols: Math.max(MIN_SESSION_COLS, client.cols),
    rows: Math.max(MIN_SESSION_ROWS, client.rows),
    role: 'controller',
    ...(streamIndex !== null ? { streamIndex } : {}),
  });
  if (restarted) {
    jsonSend(client.ws, {
      type: 'session_restarted',
      streamId,
      cols: client.cols,
      rows: client.rows,
      hostname: host.hostname,
      terminalPalette: host.terminalPalette || null,
      terminalFont: host.terminalFont || null,
    });
  }
}

/**
 * Tell every window who is attached.
 *
 * There is no controller to announce any more, so this carries the one fact
 * that changed: how many windows now share this terminal.
 */
export function broadcastControlState(relay: RelayContext, host: RelayHost): void {
  for (const clientId of host.clients) {
    const client = relay.clients.get(clientId);
    if (!client) continue;
    client.role = 'controller';
    client.controllerId = null;
    jsonSend(client.ws, {
      type: 'control_state',
      role: 'controller',
      controllerId: null,
      clientCount: host.clients.size,
    });
  }
}

/**
 * Close every window a revoked device still holds, on any host, so revoking
 * takes effect now rather than at its next reconnect. Returns how many.
 */
export function detachDeviceSessions(relay: RelayContext, deviceId: string): number {
  if (!deviceId) return 0;
  let closed = 0;
  for (const existing of [...relay.clients.values()]) {
    if (!existing || existing.deviceId !== deviceId) continue;
    detachClient(relay, existing, { notify: false, reason: 'device_revoked' });
    closeSocket(existing.ws, 1000, 'this device has been revoked by the relay operator');
    closed += 1;
  }
  return closed;
}

export function detachClient(
  relay: RelayContext,
  client: RelayClient | null | undefined,
  {
    notify = true,
    reason = 'client_disconnected',
    closeCode = 1000,
    terminate = false,
  }: DetachOptions = {},
): void {
  if (!client || !relay.clients.has(client.id)) return;
  relay.clients.delete(client.id);
  const host = relay.hosts.get(client.hostId);
  // Each window has its own PTY session. Tearing down the client immediately
  // stops its backing session on the host and cleans up its stream mapping.
  if (client.session) {
    const streamId = client.session.streamId;
    releaseSession(relay, host, client);
    if (host && isOpen(host.ws)) {
      jsonSend(host.ws, { type: 'session_stop', clientId: streamId, streamId });
    }
  }
  if (host) {
    host.clients.delete(client.id);
    notifyHostClientCount(host);
    broadcastControlState(relay, host);
    if (host.clients.size === 0) {
      host.controllerId = null;
      if (host.reconnecting) detachHost(relay, host, { notify: false, reason: 'no_clients' });
    }
  }
  const clientSocket = client.ws;
  client.ws = null;
  if (notify)
    jsonSend(clientSocket, {
      type: 'error',
      code: reason,
      message: reason === 'host_offline' ? 'Herdr host is offline' : 'connection closed',
    });
  if (terminate || clientSocket?.readyState === WebSocket.CLOSING) {
    terminateSocket(clientSocket);
  } else {
    closeSocket(clientSocket, closeCode, reason);
  }
  relay.metrics.recordCleanup('closedPtysCleaned');
}

export function detachHost(
  relay: RelayContext,
  host: RelayHost | null | undefined,
  { notify = true, reason = 'host_disconnected', terminate = false }: DetachOptions = {},
): void {
  if (!host || relay.hosts.get(host.id) !== host) return;
  if (host.reconnectTimer) clearTimeout(host.reconnectTimer);
  host.reconnectTimer = null;
  relay.hosts.delete(host.id);
  for (const clientId of [...host.clients]) {
    const client = relay.clients.get(clientId);
    if (!client) continue;
    relay.clients.delete(client.id);
    releaseSession(relay, host, client);
    const clientSocket = client.ws;
    client.ws = null;
    if (notify)
      jsonSend(clientSocket, { type: 'error', code: reason, message: 'Herdr host disconnected' });
    if (terminate || clientSocket?.readyState === WebSocket.CLOSING) {
      terminateSocket(clientSocket);
    } else {
      closeSocket(clientSocket, 1012, reason);
    }
  }
  host.clients.clear();
  relay.metrics.forgetHost(host.id);
  const hostSocket = host.ws;
  host.ws = null;
  if (terminate || hostSocket?.readyState === WebSocket.CLOSING) {
    terminateSocket(hostSocket);
  } else {
    closeSocket(hostSocket, 1000, reason);
  }
}

/** Whether `host`'s windows can keep their sessions across a host reconnect. */
export function canHandoffHost(relay: RelayContext, host: RelayHost | null | undefined): boolean {
  if (!host?.handoffCapable || host.clients.size === 0) return false;
  for (const clientId of host.clients) {
    const client = relay.clients.get(clientId);
    if (!client?.handoffCapable) return false;
  }
  return true;
}

export function beginHostReconnect(
  relay: RelayContext,
  host: RelayHost | null | undefined,
  reason = 'host_disconnected',
): void {
  if (!host || relay.hosts.get(host.id) !== host || host.reconnecting) return;
  if (!canHandoffHost(relay, host)) {
    detachHost(relay, host, { notify: true, reason });
    return;
  }
  host.ws = null;
  host.reconnecting = true;
  host.reconnectStartedAt = Date.now();
  host.lastSeenAt = Date.now();
  host.load = {};
  host.ptys = [];
  for (const clientId of host.clients) {
    const client = relay.clients.get(clientId);
    if (client) releaseSession(relay, host, client);
  }
  broadcastToClients(relay, host, () => ({ type: 'host_reconnecting', code: reason }));
  const timer = setTimeout(() => {
    host.reconnectTimer = null;
    if (relay.hosts.get(host.id) === host && host.reconnecting) {
      detachHost(relay, host, { notify: true, reason: 'host_reconnect_timeout' });
    }
  }, relay.config.relay.hostReconnectGraceMs);
  host.reconnectTimer = timer;
  timer.unref?.();
}
