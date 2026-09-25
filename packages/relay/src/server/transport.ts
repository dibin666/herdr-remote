// Sending to windows and hosts: terminal output with back-pressure, JSON
// broadcasts, and the development-only latency queue.

import { detachClient } from './sessions.js';
import { isOpen, jsonSend } from './sockets.js';
import type { RelayClient, RelayContext, RelayHost, RelaySocket, SendQueue } from './types.js';

/** Notify the host whether any browser currently needs business telemetry. */
export function notifyHostClientCount(host: RelayHost | null | undefined): void {
  if (!host || !isOpen(host.ws)) return;
  jsonSend(host.ws, { type: 'client_count', clientCount: host.clients.size });
}

/**
 * Forward output without allowing one slow browser to grow an unbounded ws
 * queue. Closing only that browser preserves low latency for the other views.
 */
export function sendClientBinary(
  relay: RelayContext,
  host: RelayHost,
  client: RelayClient | null | undefined,
  payload: Buffer,
): boolean {
  if (!client || !isOpen(client.ws)) return false;
  const limit = relay.config.relay.maxBufferedBytesPerClient;
  const buffered = Number(client.ws.bufferedAmount) || 0;
  if (buffered + payload.length > limit) {
    relay.metrics.recordCleanup('slowClientsDropped');
    detachClient(relay, client, { notify: true, reason: 'slow_client', closeCode: 1013 });
    return false;
  }
  let sent = false;
  const doSend = () => {
    if (!isOpen(client.ws)) return;
    try {
      client.ws.send(payload);
      client.bytesSent += payload.length;
      relay.metrics.recordOut(payload.length, host.id);
      sent = true;
    } catch {
      detachClient(relay, client, { notify: false, reason: 'client_send_failed', closeCode: 1011 });
    }
  };
  if (relay.devLatencyMs > 0) enqueueDelayedSend(relay, client.ws, doSend);
  else doSend();
  return relay.devLatencyMs > 0 ? true : sent;
}

/**
 * Queue artificial delay per-socket rather than using naked setTimeout calls.
 * Concurrent timers experience event loop jitter that can deliver frames out of order;
 * a single FIFO queue per socket guarantees strict in-order delivery of terminal frames.
 */
export function enqueueDelayedSend(
  relay: RelayContext,
  socket: RelaySocket,
  task: () => void,
): void {
  let queue = relay.sendQueues.get(socket);
  if (!queue) {
    const created: SendQueue = { items: [], timer: null };
    queue = created;
    relay.sendQueues.set(socket, created);
    socket.once('close', () => {
      if (created.timer) {
        clearTimeout(created.timer);
        relay.activeDelayTimers.delete(created.timer);
        created.timer = null;
      }
      created.items = [];
    });
  }
  const sendAt = Date.now() + relay.devDelayMs;
  queue.items.push({ sendAt, task });
  if (!queue.timer) {
    const pending = queue;
    const timer = setTimeout(() => flushSendQueue(relay, socket, pending), relay.devDelayMs);
    queue.timer = timer;
    relay.activeDelayTimers.add(timer);
  }
}

/**
 * Drain ready frames in FIFO order up to the current timestamp, then schedule the
 * single next timer if items remain. Ensures only one timer runs per socket at a time.
 */
export function flushSendQueue(relay: RelayContext, socket: RelaySocket, queue: SendQueue): void {
  if (queue.timer) {
    relay.activeDelayTimers.delete(queue.timer);
    queue.timer = null;
  }
  const now = Date.now();
  while (queue.items.length > 0 && queue.items[0].sendAt <= now) {
    const item = queue.items.shift();
    try {
      item?.task();
    } catch {}
  }
  if (queue.items.length > 0 && !queue.timer) {
    const nextDelay = Math.max(0, queue.items[0].sendAt - Date.now());
    const timer = setTimeout(() => flushSendQueue(relay, socket, queue), nextDelay);
    queue.timer = timer;
    relay.activeDelayTimers.add(timer);
  }
}

/** Send one JSON message to every browser attached to `host`. */
export function broadcastToClients(
  relay: RelayContext,
  host: RelayHost,
  build: (client: RelayClient) => unknown,
): void {
  for (const clientId of [...host.clients]) {
    const client = relay.clients.get(clientId);
    if (!client) continue;
    const payload = build(client);
    if (payload) jsonSend(client.ws, payload);
  }
}
