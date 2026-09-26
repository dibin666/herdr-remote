// The host connector's side of its WebSocket to the relay.

import { WebSocket } from 'ws';

/** The socket to the relay, plus the liveness flag the keepalive keeps on it. */
export type HostSocket = WebSocket & { isAlive?: boolean };

export function sendJson(ws: HostSocket | null | undefined, payload: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function closeSocket(
  ws: HostSocket | null | undefined,
  reason = 'host connector stopping',
): void {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try {
    ws.close(1000, reason);
  } catch {
    // Closing a socket that is already failing needs no further handling.
  }
}

export function terminateSocket(ws: HostSocket | null | undefined): void {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  // Tests stand in a plain object for the socket; end it however it allows.
  const socket = ws as Partial<Pick<WebSocket, 'terminate' | 'close'>> & {
    destroy?: () => void;
  };
  try {
    if (typeof socket.terminate === 'function') socket.terminate();
    else if (typeof socket.destroy === 'function') socket.destroy();
    else socket.close?.();
  } catch {
    // Tearing down a dead socket; there is nothing left to recover.
  }
}

/**
 * The stream a relay message is about. The relay sends `clientId` and
 * `streamId` with the same value; `clientId` is read first, as the protocol
 * says.
 */
export function streamOf(message: { clientId?: unknown; streamId?: unknown }): string | null {
  const id = message.clientId || message.streamId;
  return typeof id === 'string' && id ? id : null;
}
