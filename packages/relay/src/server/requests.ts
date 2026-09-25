// Who is asking, and whether to let them: origins, credentials and rate limits
// for HTTP requests and WebSocket handshakes.

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DeviceRecord } from '../auth-store.js';
import type { AttemptWindow, RelayContext } from './types.js';

/** Who an authenticated request speaks for. */
export type RequestSubject =
  | { kind: 'host'; hostId: string }
  | { kind: 'device'; hostId: string; deviceId: string };

export function bearerToken(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

export function tokenMatches(candidate: unknown, expected: unknown): boolean {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    typeof expected !== 'string' ||
    expected.length === 0
  )
    return false;
  // Hashing first gives timingSafeEqual fixed-size buffers, without leaking a
  // length mismatch through the comparison itself.
  const candidateHash = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

export function isAllowedOrigin(
  relay: RelayContext,
  origin: string | undefined,
  req: IncomingMessage,
): boolean {
  if (!origin) return true;
  const allowed = relay.config.relay.allowedOrigins || [];
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function requestOriginAllowed(relay: RelayContext, req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return isAllowedOrigin(relay, origin, req);
}

/**
 * Identify the workstation making a request by its own host token.
 * Ownership of a workstation is exactly what the host token proves, so a
 * public relay serving many workstations stays safe: nobody can mint a pairing
 * code for a host whose token they do not hold.
 */
export function authorizedHost(relay: RelayContext, req: IncomingMessage): string | null {
  const hostId = req.headers['x-herdr-host-id'];
  const token = req.headers['x-herdr-host-token'];
  if (typeof hostId !== 'string' || typeof token !== 'string') return null;
  return relay.auth.authenticateHost(hostId, token) ? hostId : null;
}

export function authorizedDevice(relay: RelayContext, req: IncomingMessage): DeviceRecord | null {
  const token = bearerToken(req);
  return token ? relay.auth.authenticateDevice(token) : null;
}

/**
 * Resolve the request to one tenant. Supplying both authentication schemes is
 * allowed only when they identify the same host; otherwise a caller could
 * accidentally combine credentials from two workstations and receive the
 * result selected by whichever branch happened to run first.
 */
export function authorizedSubject(
  relay: RelayContext,
  req: IncomingMessage,
): RequestSubject | null {
  const hostIdHeader = req.headers['x-herdr-host-id'];
  const hostTokenHeader = req.headers['x-herdr-host-token'];
  const hasHostCredentials = hostIdHeader !== undefined || hostTokenHeader !== undefined;
  const hasBearer = req.headers.authorization !== undefined;
  const hostId = authorizedHost(relay, req);
  const device = authorizedDevice(relay, req);
  if (hasHostCredentials && !hostId) return null;
  if (hasBearer && !device) return null;
  if (hostId && device && hostId !== device.hostId) return null;
  if (hostId) return { kind: 'host', hostId };
  if (device) return { kind: 'device', hostId: device.hostId, deviceId: device.deviceId };
  return null;
}

/** Authenticate the operator of this relay, not a workstation or device. */
export function authorizedAdmin(relay: RelayContext, req: IncomingMessage): boolean {
  return tokenMatches(req.headers['x-relay-admin-token'], relay.adminToken);
}

/**
 * The left-most X-Forwarded-For entry, but only when `trustProxy` says a proxy
 * sits in front of the relay: otherwise any caller could write the header.
 */
function forwardedFor(relay: RelayContext, req: IncomingMessage): string | null {
  if (!relay.trustProxy) return null;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length === 0) return null;
  return forwarded.split(',')[0].trim() || null;
}

/**
 * Rate-limit key for a request. Behind a TLS reverse proxy every connection
 * arrives from the proxy itself, so keying on the socket address would put
 * every device in the world into one bucket and let a single attacker lock
 * everyone out.
 */
export function rateLimitKey(relay: RelayContext, req: IncomingMessage): string {
  return forwardedFor(relay, req) || req.socket.remoteAddress || 'unknown';
}

/** The address a window connected from, as the operator dashboard shows it. */
export function clientAddress(relay: RelayContext, req: IncomingMessage): string | null {
  return forwardedFor(relay, req) || req.socket.remoteAddress || null;
}

export function allowAttempt(
  relay: RelayContext,
  store: Map<string, AttemptWindow>,
  req: IncomingMessage,
  limit = 20,
): boolean {
  const key = rateLimitKey(relay, req);
  const now = Date.now();
  const current = store.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    // Bound the map even when an attacker rotates source addresses. Expired
    // entries are removed by sweep; the oldest live entry is the least
    // useful one to retain when the cap is reached.
    if (store.size >= 4096) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export function allowPairAttempt(relay: RelayContext, req: IncomingMessage): boolean {
  return allowAttempt(relay, relay.pairAttempts, req, 20);
}

export function allowClientHandshake(relay: RelayContext, req: IncomingMessage): boolean {
  return allowAttempt(relay, relay.clientHandshakeAttempts, req, 60);
}

export function allowHostHandshake(relay: RelayContext, req: IncomingMessage): boolean {
  return allowAttempt(relay, relay.hostHandshakeAttempts, req, 60);
}
