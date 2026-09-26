// Timed housekeeping: ping every socket, and drop what went quiet.

import { WebSocket } from 'ws';
import { detachClient, detachHost } from './sessions.js';
import { terminateSocket } from './sockets.js';
import type { AttemptWindow, RelayContext, RelaySocket } from './types.js';

/** Close sockets that missed the last ping, and ping the rest. */
export function heartbeat(relay: RelayContext): void {
  const sockets = [
    ...[...relay.hosts.values()].map((host) => host.ws),
    ...[...relay.clients.values()].map((client) => client.ws),
  ].filter((socket): socket is RelaySocket =>
    Boolean(socket && socket.readyState !== WebSocket.CLOSED),
  );
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.CLOSING) {
      relay.metrics.recordCleanup('deadConnectionsClosed');
      terminateSocket(socket);
      continue;
    }
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (!socket.isAlive) {
      relay.metrics.recordCleanup('deadConnectionsClosed');
      terminateSocket(socket);
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // A socket failing mid-ping is terminated by the next sweep.
    }
  }
}

function forgetExpiredAttempts(store: Map<string, AttemptWindow>, now: number): void {
  for (const [key, attempt] of store.entries()) {
    if (now - attempt.startedAt >= 60_000) store.delete(key);
  }
}

/** Drop rate-limit windows, windows and hosts that have gone stale, and expired pairings. */
export function sweep(relay: RelayContext): void {
  const now = Date.now();
  const staleAfter = relay.config.cleanup.staleAfterMs;
  forgetExpiredAttempts(relay.pairAttempts, now);
  forgetExpiredAttempts(relay.clientHandshakeAttempts, now);
  forgetExpiredAttempts(relay.hostHandshakeAttempts, now);
  for (const client of [...relay.clients.values()]) {
    if (now - client.lastSeenAt > staleAfter) {
      relay.metrics.recordCleanup('staleClientsPurged');
      detachClient(relay, client, { notify: false, reason: 'stale_client', terminate: true });
    }
  }
  for (const host of [...relay.hosts.values()]) {
    if (host.reconnecting) continue;
    if (now - host.lastSeenAt > staleAfter) {
      relay.metrics.recordCleanup('deadConnectionsClosed');
      detachHost(relay, host, { notify: true, reason: 'stale_host', terminate: true });
    }
  }
  const authCleanup = relay.auth.cleanup(now);
  if (authCleanup.removedDevices || authCleanup.removedPairings)
    relay.metrics.recordCleanup('staleClientsPurged', authCleanup.removedDevices);
  relay.metrics.cleanup.lastCleanupAt = new Date(now).toISOString();
}
