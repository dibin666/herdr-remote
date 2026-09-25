// Small helpers for the relay's WebSockets and the untrusted data read from them.

import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { RelaySocket } from './types.js';

const MAX_DIMENSION = 500;

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(9).toString('base64url')}`;
}

/** A bounded string, or null. For fields whose contents a pane decided. */
export function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null;
}

export function clampDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(2, numeric));
}

export function isOpen(socket: RelaySocket | null | undefined): socket is RelaySocket {
  return Boolean(socket) && socket?.readyState === WebSocket.OPEN;
}

export function jsonSend(socket: RelaySocket | null | undefined, payload: unknown): void {
  if (isOpen(socket)) socket.send(JSON.stringify(payload));
}

export function closeSocket(
  socket: RelaySocket | null | undefined,
  code = 1000,
  reason = '',
): void {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING)
    return;
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {}
}

export function terminateSocket(socket: RelaySocket | null | undefined): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    if (typeof socket.terminate === 'function') {
      socket.terminate();
    } else if (typeof (socket as { destroy?: () => void }).destroy === 'function') {
      (socket as unknown as { destroy: () => void }).destroy();
    }
  } catch {}
}

/** Parsed JSON, or null for anything that is not a string of valid JSON. */
export function parseJson<T = Record<string, unknown>>(data: unknown): T | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function rejectHandshake(
  ws: RelaySocket,
  message: string,
  code = 'invalid_handshake',
): void {
  jsonSend(ws, { type: 'error', code, message });
  closeSocket(ws, 1008, message);
}
