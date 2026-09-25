// The relay's HTTP side: the JSON API under /api, /healthz, and the built web
// app for everything else.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import { PACKAGE_ROOT } from '../relay-config.js';
import {
  allowPairAttempt,
  authorizedAdmin,
  authorizedHost,
  authorizedSubject,
  requestOriginAllowed,
} from './requests.js';
import { detachDeviceSessions } from './sessions.js';
import { isOpen } from './sockets.js';
import { statusSnapshot } from './status.js';
import type { RelayContext } from './types.js';
import { VERSION } from './version.js';

const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'web', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

type Handler = (relay: RelayContext, req: IncomingMessage, res: ServerResponse, url: URL) => void;

interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Match every path under `path`, not just `path` itself. */
  prefix?: boolean;
  handle: Handler;
}

export function setResponseHeaders(res: ServerResponse, contentType = 'application/json'): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  );
}

export function sendJsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  setResponseHeaders(res);
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJsonResponse(res, status, { ok: false, code, message });
}

/** Whether the caller is the relay operator; answers the request when not. */
function adminAllowed(relay: RelayContext, req: IncomingMessage, res: ServerResponse): boolean {
  if (!relay.adminToken) {
    sendError(
      res,
      503,
      'admin_not_configured',
      'configure RELAY_ADMIN_TOKEN to access the relay dashboard',
    );
    return false;
  }
  if (!authorizedAdmin(relay, req)) {
    sendError(res, 401, 'admin_auth_required', 'a valid relay admin token is required');
    return false;
  }
  return true;
}

const healthz: Handler = (relay, _req, res) => {
  // Liveness is intentionally tenant-blind. Host/client counts let an
  // unauthenticated caller learn whether other workstations are present.
  sendJsonResponse(res, 200, {
    ok: true,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    uptimeSeconds: Math.floor((Date.now() - relay.startedAt) / 1000),
  });
};

const info: Handler = (relay, _req, res) => {
  const publicUrl = String(relay.config.relay.publicUrl || '').replace(/\/+$/, '');
  sendJsonResponse(res, 200, {
    ok: true,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    relayMode: relay.relayMode,
    isRemoteRelay: relay.relayMode === 'remote',
    adminConfigured: Boolean(relay.adminToken),
    adminPath: '/admin',
    adminStatusPath: '/api/admin/status',
    publicUrl,
    remoteAdminUrl: relay.relayMode === 'remote' ? `${publicUrl}/admin` : null,
  });
};

const status: Handler = (relay, req, res) => {
  const subject = authorizedSubject(relay, req);
  if (!subject) {
    sendError(res, 401, 'auth_required', 'an authorized device or host token is required');
    return;
  }
  sendJsonResponse(res, 200, statusSnapshot(relay, { scopeHostId: subject.hostId }));
};

const adminStatus: Handler = (relay, req, res) => {
  if (!adminAllowed(relay, req, res)) return;
  sendJsonResponse(res, 200, statusSnapshot(relay, { includeDevices: true }));
};

const revokeDevice: Handler = (relay, req, res, url) => {
  if (!adminAllowed(relay, req, res)) return;
  const deviceId = decodeURIComponent(url.pathname.slice('/api/admin/devices/'.length));
  const revoked = relay.auth.revokeDevice(deviceId);
  if (!revoked) {
    sendError(res, 404, 'device_not_found', 'no such paired device');
    return;
  }
  // Revocation has to take effect now, not at the next reconnect: drop any
  // socket the device still holds so the terminal closes immediately.
  const disconnected = detachDeviceSessions(relay, deviceId);
  sendJsonResponse(res, 200, { ok: true, deviceId: revoked.deviceId, disconnected });
};

const startPairing: Handler = (relay, req, res) => {
  if (!allowPairAttempt(relay, req)) {
    sendError(res, 429, 'rate_limited', 'too many pairing attempts');
    return;
  }
  const hostId = authorizedHost(relay, req);
  if (!hostId) {
    sendError(res, 401, 'host_auth_required', 'a valid host id and token are required');
    return;
  }
  const host = relay.hosts.get(hostId);
  if (!host || host.reconnecting || !isOpen(host.ws)) {
    sendError(res, 409, 'host_offline', 'no Herdr host is connected');
    return;
  }
  try {
    const pairing = relay.auth.startPairing(
      hostId,
      String(relay.config.relay.publicUrl).replace(/\/$/, ''),
    );
    sendJsonResponse(res, 200, {
      ok: true,
      ...pairing,
      pairUrl: `${pairing.publicUrl}/?pairCode=${encodeURIComponent(pairing.code)}`,
    });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    sendError(res, 409, code || 'pairing_failed', message);
  }
};

const ROUTES: Route[] = [
  { method: 'GET', path: '/healthz', handle: healthz },
  { method: 'GET', path: '/api/info', handle: info },
  { method: 'GET', path: '/api/status', handle: status },
  { method: 'GET', path: '/api/admin/status', handle: adminStatus },
  { method: 'DELETE', path: '/api/admin/devices/', prefix: true, handle: revokeDevice },
  { method: 'POST', path: '/api/pair/start', handle: startPairing },
];

export function handleHttp(relay: RelayContext, req: IncomingMessage, res: ServerResponse): void {
  let requestUrl: URL;
  try {
    requestUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(res, 400, 'bad_request', 'invalid URL');
    return;
  }
  if (!requestOriginAllowed(relay, req)) {
    sendError(res, 403, 'origin_denied', 'origin is not allowed');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, X-Herdr-Host-Id, X-Herdr-Host-Token, X-Relay-Admin-Token',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      Vary: 'Origin',
    });
    res.end();
    return;
  }
  // Only echo an origin after the exact allowlist/same-host check above. This
  // makes explicitly configured cross-origin WebUI profiles usable without
  // reflecting an attacker-controlled Origin header.
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  const { pathname } = requestUrl;
  const route = ROUTES.find(
    (candidate) =>
      candidate.method === req.method &&
      (candidate.prefix ? pathname.startsWith(candidate.path) : pathname === candidate.path),
  );
  if (route) {
    route.handle(relay, req, res, requestUrl);
    return;
  }
  if (pathname.startsWith('/api/')) {
    sendError(res, 404, 'not_found', 'API route not found');
    return;
  }
  serveStatic(pathname, res);
}

function serveStatic(requestPath: string, res: ServerResponse): void {
  const relative =
    requestPath === '/' || requestPath === '/admin'
      ? 'index.html'
      : requestPath.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relative);
  if (
    !candidate.startsWith(`${PUBLIC_DIR}${path.sep}`) &&
    candidate !== path.join(PUBLIC_DIR, 'index.html')
  ) {
    sendError(res, 403, 'forbidden', 'path is not allowed');
    return;
  }
  fs.readFile(candidate, (error, data) => {
    if (error && !path.extname(relative)) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackError, fallbackData) => {
        if (fallbackError) {
          sendError(res, 503, 'web_not_built', 'frontend has not been built');
          return;
        }
        setResponseHeaders(res, 'text/html; charset=utf-8');
        res.end(fallbackData);
      });
      return;
    }
    if (error) {
      sendError(res, 404, 'not_found', 'file not found');
      return;
    }
    const extension = path.extname(candidate).toLowerCase();
    setResponseHeaders(res, MIME_TYPES[extension] || 'application/octet-stream');
    res.end(data);
  });
}
