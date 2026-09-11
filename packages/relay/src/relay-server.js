'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');
const { loadRelayConfig, defaultStateDir, PACKAGE_ROOT } = require('./relay-config');
const { AuthStore } = require('./auth-store');
const { RelayMetrics, countActiveUsers } = require('./metrics');
const {
  unpackStreamFrame,
  packStreamFrame,
  packStreamFrameV2,
  FRAME_TYPE_INPUT,
  sanitizeTerminalPalette,
} = require('./stream-frame');
const { ensureDir } = require('./state');

const VERSION = require('../package.json').version;
const { PROTOCOL_VERSION } = require('./stream-frame');
const MAX_DIMENSION = 500;

/** Never shrink an individual session grid below something a program can still draw in. */
const MIN_SESSION_COLS = 20;
const MIN_SESSION_ROWS = 6;

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(9).toString('base64url')}`;
}

function clampDimension(value, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(2, numeric));
}

function isOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function jsonSend(socket, payload) {
  if (isOpen(socket)) socket.send(JSON.stringify(payload));
}

function closeSocket(socket, code = 1000, reason = '') {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {}
}

function terminateSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    if (typeof socket.terminate === 'function') {
      socket.terminate();
    } else if (typeof socket.destroy === 'function') {
      socket.destroy();
    }
  } catch {}
}

function parseJson(data) {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0 || typeof expected !== 'string' || expected.length === 0) return false;
  // Hashing first gives timingSafeEqual fixed-size buffers, without leaking a
  // length mismatch through the comparison itself.
  const candidateHash = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function verifyImageMagicBytes(mime, dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return false;
  let headerBuf;
  try {
    headerBuf = Buffer.from(dataBase64.slice(0, 32), 'base64');
  } catch {
    return false;
  }
  if (headerBuf.length === 0) return false;

  switch (mime) {
    case 'image/png':
      return (
        headerBuf.length >= 8 &&
        headerBuf[0] === 0x89 &&
        headerBuf[1] === 0x50 &&
        headerBuf[2] === 0x4e &&
        headerBuf[3] === 0x47
      );
    case 'image/jpeg':
      return (
        headerBuf.length >= 3 &&
        headerBuf[0] === 0xff &&
        headerBuf[1] === 0xd8 &&
        headerBuf[2] === 0xff
      );
    case 'image/webp':
      return (
        headerBuf.length >= 12 &&
        headerBuf[0] === 0x52 &&
        headerBuf[1] === 0x49 &&
        headerBuf[2] === 0x46 &&
        headerBuf[3] === 0x46 &&
        headerBuf[8] === 0x57 &&
        headerBuf[9] === 0x45 &&
        headerBuf[10] === 0x42 &&
        headerBuf[11] === 0x50
      );
    case 'image/gif':
      return (
        headerBuf.length >= 6 &&
        headerBuf[0] === 0x47 &&
        headerBuf[1] === 0x49 &&
        headerBuf[2] === 0x46 &&
        headerBuf[3] === 0x38
      );
    default:
      return false;
  }
}

class RelayServer {
  constructor(config = loadRelayConfig().config, options = {}) {
    this.config = {
      ...config,
      relay: {
        ...config.relay,
        maxHosts: config.relay?.maxHosts ?? 1024,
        maxPendingHandshakes: config.relay?.maxPendingHandshakes ?? 1024,
        maxBufferedBytesPerClient: config.relay?.maxBufferedBytesPerClient ?? 4 * 1024 * 1024,
        hostReconnectGraceMs: config.relay?.hostReconnectGraceMs ?? 30 * 1000,
      },
    };
    config = this.config;
    this.relayMode = config.relay?.mode === 'local' ? 'local' : 'remote';
    this.hosts = new Map();
    this.clients = new Map();
    this.streams = new Map();
    this.pairAttempts = new Map();
    this.clientHandshakeAttempts = new Map();
    this.hostHandshakeAttempts = new Map();
    this.pendingHandshakes = new Set();
    this.startedAt = Date.now();
    this.metrics = options.metrics || new RelayMetrics({ version: VERSION, protocolVersion: PROTOCOL_VERSION });
    this.stateFile = options.stateFile || config.auth?.stateFile || path.join(defaultStateDir(), 'relay-auth.json');
    this.password = options.password ?? config.auth?.password ?? null;
    this.adminToken = options.adminToken ?? config.auth?.adminToken ?? null;
    this.trustProxy = Boolean(options.trustProxy ?? config.relay.trustProxy);
    // Development-only artificial latency switch for local responsiveness profiling.
    // When unset or 0, this incurs zero overhead and avoids entering the delayed path.
    // RELAY_DEV_LATENCY_MS specifies round-trip delay, so each one-way leg
    // (host -> browser and browser -> host) is delayed by half.
    const devLatencyRaw = options.devLatencyMs ?? config.relay?.devLatencyMs ?? process.env.RELAY_DEV_LATENCY_MS;
    this.devLatencyMs = devLatencyRaw ? Math.max(0, parseInt(devLatencyRaw, 10) || 0) : 0;
    this.devDelayMs = this.devLatencyMs > 0 ? Math.round(this.devLatencyMs / 2) : 0;
    this.sendQueues = new WeakMap();
    this.activeDelayTimers = new Set();
    this.auth = options.auth || new AuthStore({
      stateFile: this.stateFile,
      pairingTtlMs: config.auth.pairingTtlMs,
      deviceTtlMs: config.auth.deviceTtlMs,
      maxDevices: config.auth.maxDevices,
      password: this.password,
    });
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: config.relay.maxPayloadBytes,
      // Frames below 1024 bytes bypass compression completely, ensuring single
      // keystrokes and small echoes incur zero CPU and zero buffering delay.
      // Keeping context across messages (NoContextTakeover=false) maximizes
      // compression ratios on highly repetitive full-screen ratatui/ANSI redraws;
      // level 3 provides low CPU cost and low latency over peak compression.
      perMessageDeflate: {
        threshold: 1024,
        zlibDeflateOptions: { level: 3 },
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
        concurrencyLimit: 10,
      },
    });
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  listen(port = this.config.relay.port, host = this.config.relay.host) {
    ensureDir(path.dirname(this.stateFile));
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.config.cleanup.heartbeatIntervalMs);
        this.cleanupTimer = setInterval(() => this.sweep(), this.config.cleanup.intervalMs);
        resolve(this.address());
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
  }

  address() {
    const address = this.server.address();
    if (!address) return null;
    return typeof address === 'string' ? { path: address } : { host: address.address, port: address.port };
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
    if (this.activeDelayTimers) {
      for (const timer of this.activeDelayTimers) clearTimeout(timer);
      this.activeDelayTimers.clear();
    }
    for (const client of [...this.clients.values()]) this.detachClient(client, { notify: false });
    for (const host of [...this.hosts.values()]) this.detachHost(host, { notify: false });
    this.streams.clear();
    this.pairAttempts.clear();
    this.clientHandshakeAttempts.clear();
    this.hostHandshakeAttempts.clear();
    this.pendingHandshakes.clear();
    this.metrics.close();
    await new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  isAllowedOrigin(origin, req) {
    if (!origin) return true;
    const allowed = this.config.relay.allowedOrigins || [];
    if (allowed.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  requestOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return this.isAllowedOrigin(origin, req);
  }

  handleUpgrade(req, socket, head) {
    const pathname = (() => {
      try {
        return new URL(req.url, 'http://localhost').pathname;
      } catch {
        return '';
      }
    })();
    if (!['/ws/host', '/ws/client'].includes(pathname) || !this.isAllowedOrigin(req.headers.origin, req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.pendingHandshakes.size >= this.config.relay.maxPendingHandshakes) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Small ANSI/input frames should not wait behind Nagle's timer. This is
    // safe for both plain HTTP and TLS sockets and also benefits a relay behind
    // a reverse proxy by keeping the relay leg immediately writable.
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive?.(true, this.config.cleanup.heartbeatIntervalMs);
    } catch {}
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.pendingHandshakes.add(ws);
      ws.once('close', () => this.finishHandshake(ws));
      if (pathname === '/ws/host') this.handleHostConnection(ws, req);
      else this.handleClientConnection(ws, req);
    });
  }

  setResponseHeaders(res, contentType = 'application/json') {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
  }

  sendJsonResponse(res, status, payload) {
    this.setResponseHeaders(res);
    res.writeHead(status);
    res.end(JSON.stringify(payload));
  }

  /**
   * Identify the workstation making a request by its own host token.
   * Ownership of a workstation is exactly what the host token proves, so a
   * public relay serving many workstations stays safe: nobody can mint a pairing
   * code for a host whose token they do not hold.
   */
  authorizedHost(req) {
    const hostId = req.headers['x-herdr-host-id'];
    const token = req.headers['x-herdr-host-token'];
    if (typeof hostId !== 'string' || typeof token !== 'string') return null;
    return this.auth.authenticateHost(hostId, token) ? hostId : null;
  }

  authorizedDevice(req) {
    const token = bearerToken(req);
    return token ? this.auth.authenticateDevice(token) : null;
  }

  /**
   * Resolve the request to one tenant. Supplying both authentication schemes is
   * allowed only when they identify the same host; otherwise a caller could
   * accidentally combine credentials from two workstations and receive the
   * result selected by whichever branch happened to run first.
   */
  authorizedSubject(req) {
    const hostIdHeader = req.headers['x-herdr-host-id'];
    const hostTokenHeader = req.headers['x-herdr-host-token'];
    const hasHostCredentials = hostIdHeader !== undefined || hostTokenHeader !== undefined;
    const hasBearer = req.headers.authorization !== undefined;
    const hostId = this.authorizedHost(req);
    const device = this.authorizedDevice(req);
    if (hasHostCredentials && !hostId) return null;
    if (hasBearer && !device) return null;
    if (hostId && device && hostId !== device.hostId) return null;
    if (hostId) return { kind: 'host', hostId };
    if (device) return { kind: 'device', hostId: device.hostId, deviceId: device.deviceId };
    return null;
  }

  /** Authenticate the operator of this relay, not a workstation or device. */
  authorizedAdmin(req) {
    return tokenMatches(req.headers['x-relay-admin-token'], this.adminToken);
  }

  /**
   * Rate-limit key for a request. Behind a TLS reverse proxy every connection
   * arrives from the proxy itself, so keying on the socket address would put
   * every device in the world into one bucket and let a single attacker lock
   * everyone out. `trustProxy` switches to the left-most X-Forwarded-For entry,
   * which is only trustworthy when a proxy is actually in front of the relay.
   */
  rateLimitKey(req) {
    if (this.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  allowAttempt(store, req, limit = 20) {
    const key = this.rateLimitKey(req);
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

  allowPairAttempt(req) {
    return this.allowAttempt(this.pairAttempts, req, 20);
  }

  allowClientHandshake(req) {
    return this.allowAttempt(this.clientHandshakeAttempts, req, 60);
  }

  allowHostHandshake(req) {
    return this.allowAttempt(this.hostHandshakeAttempts, req, 60);
  }

  finishHandshake(ws) {
    this.pendingHandshakes.delete(ws);
  }

  handleHttp(req, res) {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      this.sendJsonResponse(res, 400, { ok: false, code: 'bad_request', message: 'invalid URL' });
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!this.requestOriginAllowed(req)) {
        this.sendJsonResponse(res, 403, { ok: false, code: 'origin_denied', message: 'origin is not allowed' });
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Herdr-Host-Id, X-Herdr-Host-Token, X-Relay-Admin-Token',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        Vary: 'Origin',
      });
      res.end();
      return;
    }
    if (!this.requestOriginAllowed(req)) {
      this.sendJsonResponse(res, 403, { ok: false, code: 'origin_denied', message: 'origin is not allowed' });
      return;
    }
    // Only echo an origin after the exact allowlist/same-host check above. This
    // makes explicitly configured cross-origin WebUI profiles usable without
    // reflecting an attacker-controlled Origin header.
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
      // Liveness is intentionally tenant-blind. Host/client counts let an
      // unauthenticated caller learn whether other workstations are present.
      this.sendJsonResponse(res, 200, {
        ok: true,
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      });
      return;
    }
    if (requestUrl.pathname === '/api/info' && req.method === 'GET') {
      const publicUrl = String(this.config.relay.publicUrl || '').replace(/\/+$/, '');
      this.sendJsonResponse(res, 200, {
        ok: true,
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        relayMode: this.relayMode,
        isRemoteRelay: this.relayMode === 'remote',
        adminConfigured: Boolean(this.adminToken),
        adminPath: '/admin',
        adminStatusPath: '/api/admin/status',
        publicUrl,
        remoteAdminUrl: this.relayMode === 'remote' ? `${publicUrl}/admin` : null,
      });
      return;
    }
    if (requestUrl.pathname === '/api/status' && req.method === 'GET') {
      const subject = this.authorizedSubject(req);
      if (!subject) {
        this.sendJsonResponse(res, 401, { ok: false, code: 'auth_required', message: 'an authorized device or host token is required' });
        return;
      }
      this.sendJsonResponse(res, 200, this.statusSnapshot({ scopeHostId: subject.hostId }));
      return;
    }
    if (requestUrl.pathname === '/api/admin/status' && req.method === 'GET') {
      if (!this.adminToken) {
        this.sendJsonResponse(res, 503, { ok: false, code: 'admin_not_configured', message: 'configure RELAY_ADMIN_TOKEN to access the relay dashboard' });
        return;
      }
      if (!this.authorizedAdmin(req)) {
        this.sendJsonResponse(res, 401, { ok: false, code: 'admin_auth_required', message: 'a valid relay admin token is required' });
        return;
      }
      this.sendJsonResponse(res, 200, this.statusSnapshot({ includeDevices: true }));
      return;
    }
    if (requestUrl.pathname.startsWith('/api/admin/devices/') && req.method === 'DELETE') {
      if (!this.adminToken) {
        this.sendJsonResponse(res, 503, { ok: false, code: 'admin_not_configured', message: 'configure RELAY_ADMIN_TOKEN to access the relay dashboard' });
        return;
      }
      if (!this.authorizedAdmin(req)) {
        this.sendJsonResponse(res, 401, { ok: false, code: 'admin_auth_required', message: 'a valid relay admin token is required' });
        return;
      }
      const deviceId = decodeURIComponent(requestUrl.pathname.slice('/api/admin/devices/'.length));
      const revoked = this.auth.revokeDevice(deviceId);
      if (!revoked) {
        this.sendJsonResponse(res, 404, { ok: false, code: 'device_not_found', message: 'no such paired device' });
        return;
      }
      // Revocation has to take effect now, not at the next reconnect: drop any
      // socket the device still holds so the terminal closes immediately.
      const disconnected = this.detachDeviceSessions(deviceId);
      this.sendJsonResponse(res, 200, { ok: true, deviceId: revoked.deviceId, disconnected });
      return;
    }
    if (requestUrl.pathname === '/api/pair/start' && req.method === 'POST') {
      if (!this.allowPairAttempt(req)) {
        this.sendJsonResponse(res, 429, { ok: false, code: 'rate_limited', message: 'too many pairing attempts' });
        return;
      }
      const hostId = this.authorizedHost(req);
      if (!hostId) {
        this.sendJsonResponse(res, 401, { ok: false, code: 'host_auth_required', message: 'a valid host id and token are required' });
        return;
      }
      const host = this.hosts.get(hostId);
      if (!host || host.reconnecting || !isOpen(host.ws)) {
        this.sendJsonResponse(res, 409, { ok: false, code: 'host_offline', message: 'no Herdr host is connected' });
        return;
      }
      try {
        const pairing = this.auth.startPairing(hostId, String(this.config.relay.publicUrl).replace(/\/$/, ''));
        this.sendJsonResponse(res, 200, { ok: true, ...pairing, pairUrl: `${pairing.publicUrl}/?pairCode=${encodeURIComponent(pairing.code)}` });
      } catch (error) {
        this.sendJsonResponse(res, 409, { ok: false, code: error.code || 'pairing_failed', message: error.message });
      }
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      this.sendJsonResponse(res, 404, { ok: false, code: 'not_found', message: 'API route not found' });
      return;
    }
    this.serveStatic(requestUrl.pathname, res);
  }

  serveStatic(requestPath, res) {
    const publicDir = path.join(PACKAGE_ROOT, 'web', 'dist');
    const relative = requestPath === '/' || requestPath === '/admin' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const candidate = path.resolve(publicDir, relative);
    if (!candidate.startsWith(`${publicDir}${path.sep}`) && candidate !== path.join(publicDir, 'index.html')) {
      this.sendJsonResponse(res, 403, { ok: false, code: 'forbidden', message: 'path is not allowed' });
      return;
    }
    fs.readFile(candidate, (error, data) => {
      if (error && !path.extname(relative)) {
        fs.readFile(path.join(publicDir, 'index.html'), (fallbackError, fallbackData) => {
          if (fallbackError) {
            this.sendJsonResponse(res, 503, { ok: false, code: 'web_not_built', message: 'frontend has not been built' });
            return;
          }
          this.setResponseHeaders(res, 'text/html; charset=utf-8');
          res.end(fallbackData);
        });
        return;
      }
      if (error) {
        this.sendJsonResponse(res, 404, { ok: false, code: 'not_found', message: 'file not found' });
        return;
      }
      const extension = path.extname(candidate).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
      }[extension] || 'application/octet-stream';
      this.setResponseHeaders(res, mime);
      res.end(data);
    });
  }

  createHostRecord(message, ws, pending, clients = new Set()) {
    const capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
    return {
      id: message.hostId,
      ws,
      hostname: typeof message.hostname === 'string' ? message.hostname.slice(0, 128) : os.hostname(),
      platform: typeof message.platform === 'string' ? message.platform.slice(0, 32) : process.platform,
      arch: typeof message.arch === 'string' ? message.arch.slice(0, 32) : process.arch,
      connectedAt: new Date(pending.connectedAt).toISOString(),
      connectedAtMs: pending.connectedAt,
      terminalPalette: sanitizeTerminalPalette(message.terminalPalette),
      lastSeenAt: Date.now(),
      clients,
      controllerId: null,
      load: {},
      ptys: [],
      reconnecting: false,
      reconnectTimer: null,
      connectionGeneration: randomId('host-connection'),
      handoffCapable: capabilities.includes('host_handoff'),
      binaryFrameV2: capabilities.includes('binary_frame_v2'),
      streamIndices: new Map(),
      nextStreamIndex: 0,
      shutdownRequested: false,
    };
  }

  allocateStreamIndex(host) {
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

  canHandoffHost(host) {
    if (!host?.handoffCapable || host.clients.size === 0) return false;
    for (const clientId of host.clients) {
      const client = this.clients.get(clientId);
      if (!client?.handoffCapable) return false;
    }
    return true;
  }

  beginHostReconnect(host, reason = 'host_disconnected') {
    if (!host || this.hosts.get(host.id) !== host || host.reconnecting) return;
    if (!this.canHandoffHost(host)) {
      this.detachHost(host, { notify: true, reason });
      return;
    }
    host.ws = null;
    host.reconnecting = true;
    host.reconnectStartedAt = Date.now();
    host.lastSeenAt = Date.now();
    host.load = {};
    host.ptys = [];
    for (const clientId of host.clients) {
      const client = this.clients.get(clientId);
      if (client?.session) {
        if (client.session.streamIndex !== null && client.session.streamIndex !== undefined) {
          host.streamIndices.delete(client.session.streamIndex);
        }
        this.streams.delete(client.session.streamId);
        client.session = null;
      }
    }
    this.broadcastToClients(host, () => ({ type: 'host_reconnecting', code: reason }));
    host.reconnectTimer = setTimeout(() => {
      host.reconnectTimer = null;
      if (this.hosts.get(host.id) === host && host.reconnecting) {
        this.detachHost(host, { notify: true, reason: 'host_reconnect_timeout' });
      }
    }, this.config.relay.hostReconnectGraceMs);
    host.reconnectTimer.unref?.();
  }

  handleHostConnection(ws, req) {
    const pending = { ws, remoteAddress: req.socket.remoteAddress, connectedAt: Date.now(), authenticated: false };
    const deadline = setTimeout(() => {
      if (!pending.authenticated) closeSocket(ws, 1008, 'host hello timeout');
    }, 10000);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      if (pending.host) pending.host.lastSeenAt = Date.now();
    });
    ws.on('ping', () => {
      ws.isAlive = true;
      if (pending.host) pending.host.lastSeenAt = Date.now();
    });
    ws.on('message', (raw, isBinary) => {
      if (!pending.authenticated) {
        if (isBinary) return this.rejectHandshake(ws, 'host hello must be JSON');
        const message = parseJson(raw.toString());
        if (!message || message.type !== 'host_hello' || message.protocol !== PROTOCOL_VERSION) return this.rejectHandshake(ws, 'invalid host hello');
        if (!this.allowHostHandshake(req)) return this.rejectHandshake(ws, 'too many connection attempts', 'rate_limited');
        const oldHost = this.hosts.get(message.hostId);
        if (!oldHost && this.hosts.size >= this.config.relay.maxHosts) {
          return this.rejectHandshake(ws, 'relay host limit reached', 'too_many_hosts');
        }
        const registration = this.auth.registerHost(message.hostId, message.token, message.password ?? null);
        if (!registration.ok) return this.rejectHandshake(ws, registration.message, registration.code);
        clearTimeout(deadline);
        pending.authenticated = true;
        this.finishHandshake(ws);

        const handoff = this.canHandoffHost(oldHost);
        const retainedClients = handoff ? oldHost.clients : new Set();
        if (oldHost) {
          if (oldHost.reconnectTimer) clearTimeout(oldHost.reconnectTimer);
          oldHost.reconnectTimer = null;
          if (handoff) {
            for (const clientId of oldHost.clients) {
              const client = this.clients.get(clientId);
              if (client?.session) {
                if (isOpen(oldHost.ws)) {
                  jsonSend(oldHost.ws, {
                    type: 'session_stop',
                    clientId: client.session.streamId,
                    streamId: client.session.streamId,
                  });
                }
                if (client.session.streamIndex !== null && client.session.streamIndex !== undefined) {
                  oldHost.streamIndices.delete(client.session.streamIndex);
                }
                this.streams.delete(client.session.streamId);
                client.session = null;
              }
            }
            oldHost.load = {};
            oldHost.ptys = [];
            this.broadcastToClients(oldHost, () => ({ type: 'host_reconnecting', code: 'host_replaced' }));
          } else {
            this.detachHost(oldHost, { notify: true, reason: 'host_replaced' });
          }
        }

        const host = this.createHostRecord(message, ws, pending, retainedClients);
        pending.host = host;
        // Install the new record before closing the old socket. Its delayed
        // close handler then fails the identity check instead of detaching the
        // freshly authenticated host.
        this.hosts.set(host.id, host);
        if (oldHost && handoff) closeSocket(oldHost.ws, 1000, 'host_replaced');
        jsonSend(ws, {
          type: 'host_ready',
          protocol: PROTOCOL_VERSION,
          hostId: host.id,
          clientCount: host.clients.size,
        });
        this.notifyHostClientCount(host);
        if (handoff) {
          for (const clientId of host.clients) {
            const client = this.clients.get(clientId);
            if (client) this.startSession(host, client, { restarted: true });
          }
        }
        return;
      }
      this.handleHostMessage(pending.host, raw, isBinary);
    });
    ws.on('close', (_code, rawReason) => {
      clearTimeout(deadline);
      const host = pending.host;
      if (!host || this.hosts.get(host.id) !== host || host.ws !== ws) return;
      const reason = rawReason ? rawReason.toString() : '';
      if (reason === 'host_shutdown') host.shutdownRequested = true;
      if (host.shutdownRequested || !this.canHandoffHost(host)) {
        this.detachHost(host, { notify: true, reason: host.shutdownRequested ? 'host_shutdown' : 'host_disconnected' });
        return;
      }
      this.beginHostReconnect(host, 'host_disconnected');
    });
    ws.on('error', () => {});
  }

  rejectHandshake(ws, message, code = 'invalid_handshake') {
    jsonSend(ws, { type: 'error', code, message });
    closeSocket(ws, 1008, message);
  }

  handleHostMessage(host, raw, isBinary) {
    host.lastSeenAt = Date.now();
    if (isBinary) {
      let frame;
      try {
        frame = unpackStreamFrame(raw);
      } catch (error) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        closeSocket(host.ws, 1003, error.message);
        return;
      }
      // Postel's law: be conservative in what you send, liberal in what you accept.
      // We strictly send v2 only to hosts that negotiated binary_frame_v2, but we accept
      // both v1 and v2 on receipt: a v2-capable host falls back to v1 if stream indices
      // were exhausted for a session, and an unnegotiated host sending v2 simply finds
      // no routed client instead of having its entire connection severed.
      // Output is routed to the single client owning the stream rather than broadcast.
      if (frame.type !== 'output') return;
      const clientId = frame.version === 2
        ? host.streamIndices.get(frame.streamIndex)
        : this.streams.get(frame.streamId);
      if (!clientId) return;
      const client = this.clients.get(clientId);
      if (!client || !isOpen(client.ws)) return;
      this.sendClientBinary(host, client, frame.payload);
      return;
    }
    const message = parseJson(raw.toString());
    if (!message) return;
    if (message.type === 'heartbeat') {
      host.load = message.load && typeof message.load === 'object' ? message.load : {};
      host.ptys = Array.isArray(message.ptys) ? message.ptys.slice(0, 256) : [];
      return;
    }
    if (message.type === 'host_shutdown') {
      host.shutdownRequested = true;
      if (this.hosts.get(host.id) === host) this.detachHost(host, { notify: true, reason: 'host_shutdown' });
      return;
    }
    // Session events target the single client that owns this stream.
    const streamId = typeof message.clientId === 'string' ? message.clientId : message.streamId;
    const clientId = streamId ? this.streams.get(streamId) : null;
    const client = clientId ? this.clients.get(clientId) : null;
    if (!client) return;

    if (message.type === 'session_ready') {
      if (client.session) client.session.ready = true;
      jsonSend(client.ws, { type: 'session_ready', clientId: client.id });
    } else if (message.type === 'session_exit') {
      const code = Number.isInteger(message.code) ? message.code : null;
      jsonSend(client.ws, { type: 'exit', code });
      if (client.session) {
        if (client.session.streamIndex !== null && client.session.streamIndex !== undefined) {
          host.streamIndices.delete(client.session.streamIndex);
        }
        this.streams.delete(client.session.streamId);
        client.session = null;
      }
      this.detachClient(client, { notify: false });
    } else if (message.type === 'paste_file_ready') {
      jsonSend(client.ws, {
        type: 'paste_file_ready',
        path: message.path,
      });
    } else if (message.type === 'error') {
      jsonSend(client.ws, {
        type: 'error',
        code: message.code || 'host_error',
        message: String(message.message || 'Host connector error'),
      });
    }
  }

  /** Notify the host whether any browser currently needs business telemetry. */
  notifyHostClientCount(host) {
    if (!host || !isOpen(host.ws)) return;
    jsonSend(host.ws, { type: 'client_count', clientCount: host.clients.size });
  }

  /**
   * Forward output without allowing one slow browser to grow an unbounded ws
   * queue. Closing only that browser preserves low latency for the other views.
   */
  sendClientBinary(host, client, payload) {
    if (!client || !isOpen(client.ws)) return false;
    const limit = this.config.relay.maxBufferedBytesPerClient;
    const buffered = Number(client.ws.bufferedAmount) || 0;
    if (buffered + payload.length > limit) {
      this.metrics.recordCleanup('slowClientsDropped');
      this.detachClient(client, { notify: true, reason: 'slow_client', closeCode: 1013 });
      return false;
    }
    let sent = false;
    const doSend = () => {
      if (!isOpen(client.ws)) return;
      try {
        client.ws.send(payload);
        client.bytesSent += payload.length;
        this.metrics.recordOut(payload.length, host.id);
        sent = true;
      } catch {
        this.detachClient(client, { notify: false, reason: 'client_send_failed', closeCode: 1011 });
      }
    };
    if (this.devLatencyMs > 0) this.enqueueDelayedSend(client.ws, doSend);
    else doSend();
    return this.devLatencyMs > 0 ? true : sent;
  }

  /**
   * Queue artificial delay per-socket rather than using naked setTimeout calls.
   * Concurrent timers experience event loop jitter that can deliver frames out of order;
   * a single FIFO queue per socket guarantees strict in-order delivery of terminal frames.
   */
  enqueueDelayedSend(socket, task) {
    let queue = this.sendQueues.get(socket);
    if (!queue) {
      queue = { items: [], timer: null };
      this.sendQueues.set(socket, queue);
      socket.once('close', () => {
        if (queue.timer) {
          clearTimeout(queue.timer);
          this.activeDelayTimers.delete(queue.timer);
          queue.timer = null;
        }
        queue.items = [];
      });
    }
    const sendAt = Date.now() + this.devDelayMs;
    queue.items.push({ sendAt, task });
    if (!queue.timer) {
      const timer = setTimeout(() => this.flushSendQueue(socket, queue), this.devDelayMs);
      queue.timer = timer;
      this.activeDelayTimers.add(timer);
    }
  }

  /**
   * Drain ready frames in FIFO order up to the current timestamp, then schedule the
   * single next timer if items remain. Ensures only one timer runs per socket at a time.
   */
  flushSendQueue(socket, queue) {
    if (queue.timer) {
      this.activeDelayTimers.delete(queue.timer);
      queue.timer = null;
    }
    const now = Date.now();
    while (queue.items.length > 0 && queue.items[0].sendAt <= now) {
      const item = queue.items.shift();
      try {
        item.task();
      } catch {}
    }
    if (queue.items.length > 0 && !queue.timer) {
      const nextDelay = Math.max(0, queue.items[0].sendAt - Date.now());
      const timer = setTimeout(() => this.flushSendQueue(socket, queue), nextDelay);
      queue.timer = timer;
      this.activeDelayTimers.add(timer);
    }
  }

  /** Send one JSON message to every browser attached to `host`. */
  broadcastToClients(host, build) {
    for (const clientId of [...host.clients]) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      const payload = build(client);
      if (payload) jsonSend(client.ws, payload);
    }
  }

  /** Start a dedicated PTY session for one attached client. */
  startSession(host, client, { restarted = false } = {}) {
    if (!client || !isOpen(host.ws)) return;
    const streamId = randomId('session');
    let streamIndex = null;
    if (host.binaryFrameV2) {
      streamIndex = this.allocateStreamIndex(host);
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
    this.streams.set(streamId, client.id);
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
      });
    }
  }

  handleClientConnection(ws, req) {
    const pending = { ws, req, authenticated: false };
    const deadline = setTimeout(() => {
      if (!pending.authenticated) closeSocket(ws, 1008, 'client hello timeout');
    }, 10000);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      if (pending.client) {
        pending.client.lastSeenAt = Date.now();
        pending.client.lastPingAt = new Date().toISOString();
      }
    });
    ws.on('ping', () => {
      ws.isAlive = true;
      if (pending.client) {
        pending.client.lastSeenAt = Date.now();
        pending.client.lastPingAt = new Date().toISOString();
      }
    });
    ws.on('message', (raw, isBinary) => {
      if (!pending.authenticated) {
        if (isBinary) return this.rejectHandshake(ws, 'client hello must be JSON');
        const message = parseJson(raw.toString());
        if (!message || message.type !== 'hello' || message.protocol !== PROTOCOL_VERSION) return this.rejectHandshake(ws, 'invalid client hello');
        if (!this.allowClientHandshake(req)) return this.rejectHandshake(ws, 'too many connection attempts', 'rate_limited');
        let device = null;
        let paired = null;
        if (message.pairCode) {
          if (!this.allowPairAttempt(req)) return this.rejectHandshake(ws, 'too many pairing attempts', 'rate_limited');
          paired = this.auth.completePairing(message.pairCode);
        }
        if (paired) device = paired;
        else if (message.token) device = this.auth.authenticateDevice(message.token);
        if (!device) return this.rejectHandshake(ws, 'valid device token or pairing code required', 'auth_required');
        const host = this.hosts.get(device.hostId);
        if (!host || host.reconnecting || !isOpen(host.ws)) return this.rejectHandshake(ws, 'paired Herdr host is offline', host?.reconnecting ? 'host_reconnecting' : 'host_offline');

        // Two tabs of one browser are separate windows with their own PTY sessions,
        // not rivals. Nothing is retired here: each connection gets its own stream
        // without evicting existing clients.
        if (host.clients.size >= this.config.relay.maxClientsPerHost) return this.rejectHandshake(ws, 'host client limit reached', 'too_many_clients');
        clearTimeout(deadline);
        this.finishHandshake(ws);
        const clientId = randomId('client');
        const client = {
          id: clientId,
          ws,
          hostId: host.id,
          deviceId: device.deviceId,
          // Stable per browser profile; used to recognise a reconnect from the
          // same browser rather than a genuinely separate viewer.
          browserClientId: typeof message.clientId === 'string' ? message.clientId.slice(0, 128) : null,
          handoffCapable: Array.isArray(message.capabilities) && message.capabilities.includes('host_handoff'),
          session: null,
          // Every paired window gets its own interactive PTY session. Pairing
          // is the permission boundary; once a device is through it, every
          // window can type into its own terminal.
          role: 'controller',
          controllerId: null,
          connectedAt: new Date().toISOString(),
          connectedAtMs: Date.now(),
          lastSeenAt: Date.now(),
          lastPingAt: null,
          bytesReceived: 0,
          bytesSent: 0,
          ip: this.clientAddress(req),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
          cols: clampDimension(message.cols, 80),
          rows: clampDimension(message.rows, 24),
        };
        client.controllerId = null;
        // Persist how this device identifies itself so the operator dashboard
        // can name it in the revoke list instead of showing a bare device id.
        this.auth.noteDeviceSeen(device.deviceId, { userAgent: client.userAgent, ip: client.ip });
        pending.authenticated = true;
        pending.client = client;
        this.clients.set(client.id, client);
        host.clients.add(client.id);
        this.notifyHostClientCount(host);
        ws.isAlive = true;
        if (paired) jsonSend(ws, { type: 'paired', token: paired.token, deviceId: paired.deviceId, hostId: paired.hostId, expiresAt: paired.expiresAtIso });
        // Expose the relay-assigned connection id so clients can distinguish
        // their own controller lease from another device's lease. The browser
        // supplied clientId identifies a device, not this live WebSocket.
        jsonSend(ws, {
          type: 'ready',
          role: client.role,
          // There is no controller to name: every window has full input. The
          // field stays in the message for clients built against protocol 1,
          // which read it to decide whether somebody else held the lease — and
          // `null` is exactly the answer that means "nobody does".
          controllerId: null,
          hostId: host.id,
          hostname: host.hostname,
          clientId: client.id,
          // Delivered with `ready`, before the first PTY byte, so the terminal
          // is painted in the host's colors from its very first frame.
          terminalPalette: host.terminalPalette || null,
          clientCount: host.clients.size,
        });
        this.startSession(host, client);
        this.broadcastControlState(host);
        return;
      }
      this.handleClientMessage(pending.client, raw, isBinary);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (pending.client) this.detachClient(pending.client, { notify: true });
    });
    ws.on('error', () => {});
  }

  handleClientMessage(client, raw, isBinary) {
    client.lastSeenAt = Date.now();
    const host = this.hosts.get(client.hostId);
    if (!host) return this.detachClient(client, { notify: true, reason: 'host_offline' });
    if (isBinary) {
      if (raw.length > this.config.relay.maxPayloadBytes) return;
      if (!client.session) return;
      // Each window owns its own PTY session, so input is stamped with the
      // client's dedicated stream id or streamIndex.
      const frame = host.binaryFrameV2 && typeof client.session.streamIndex === 'number'
        ? packStreamFrameV2(FRAME_TYPE_INPUT, client.session.streamIndex, raw)
        : packStreamFrame('input', client.session.streamId, raw);
      if (isOpen(host.ws)) {
        const doSend = () => {
          if (!isOpen(host.ws)) return;
          try {
            host.ws.send(frame);
            client.bytesReceived += raw.length;
            this.metrics.recordIn(raw.length, host.id);
          } catch {
            this.beginHostReconnect(host, 'host_send_failed');
          }
        };
        if (this.devLatencyMs > 0) this.enqueueDelayedSend(host.ws, doSend);
        else doSend();
      }
      return;
    }
    const message = parseJson(raw.toString());
    if (!message) {
      jsonSend(client.ws, { type: 'error', code: 'invalid_json', message: 'message must be JSON' });
      return;
    }
    if (message.type === 'ping') {
      client.lastPingAt = new Date().toISOString();
      jsonSend(client.ws, { type: 'pong' });
    } else if (message.type === 'resize') {
      // Each client owns its own PTY session, so resizing directly forwards
      // the new geometry for this client's stream to the host.
      client.cols = clampDimension(message.cols, client.cols);
      client.rows = clampDimension(message.rows, client.rows);
      if (client.session) {
        client.session.cols = client.cols;
        client.session.rows = client.rows;
        if (isOpen(host.ws)) {
          jsonSend(host.ws, {
            type: 'resize',
            clientId: client.session.streamId,
            streamId: client.session.streamId,
            cols: Math.max(MIN_SESSION_COLS, client.cols),
            rows: Math.max(MIN_SESSION_ROWS, client.rows),
          });
        }
      }
    } else if (message.type === 'claim_control') {
      // Control is no longer a lease. Answering the old request keeps clients
      // built against the previous protocol working.
      client.role = 'controller';
      jsonSend(client.ws, { type: 'control_granted' });
    } else if (message.type === 'release_control') {
      // Nothing to release: the window keeps its input either way, and saying
      // so beats a silence an older client would wait on.
      jsonSend(client.ws, { type: 'control_state', role: 'controller', controllerId: null });
    }
    else if (message.type === 'paste_file') {
      if (client.role === 'viewer') {
        jsonSend(client.ws, {
          type: 'error',
          code: 'viewer_mode',
          message: 'Viewer mode cannot paste to terminal',
        });
        return;
      }
      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
      if (typeof message.mime !== 'string' || !allowedMimes.has(message.mime)) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'paste_file_unsupported',
          message: 'Unsupported paste image format',
        });
        return;
      }
      if (typeof message.dataBase64 !== 'string') {
        jsonSend(client.ws, {
          type: 'error',
          code: 'paste_file_unsupported',
          message: 'Invalid paste image payload',
        });
        return;
      }
      const MAX_PASTE_BYTES = 3 * 1024 * 1024;
      const rawLength = Buffer.byteLength(message.dataBase64, 'base64');
      if (rawLength === 0) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'paste_file_empty',
          message: 'Pasted image payload is empty',
        });
        return;
      }
      if (rawLength > MAX_PASTE_BYTES) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'paste_file_too_large',
          message: 'Pasted image exceeds 3 MB limit',
        });
        return;
      }
      if (!verifyImageMagicBytes(message.mime, message.dataBase64)) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'paste_file_unsupported',
          message: 'Pasted image content does not match declared MIME type',
        });
        return;
      }
      if (!isOpen(host?.ws)) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'host_offline',
          message: 'Host is offline or disconnected',
        });
        return;
      }
      if (!client.session) {
        jsonSend(client.ws, {
          type: 'error',
          code: 'no_session',
          message: 'Terminal session is not ready',
        });
        return;
      }
      jsonSend(host.ws, {
        type: 'paste_file',
        clientId: client.session.streamId,
        streamId: client.session.streamId,
        mime: message.mime,
        dataBase64: message.dataBase64,
      });
    }
  }

  /**
   * Tell every window who is attached.
   *
   * There is no controller to announce any more, so this carries the one fact
   * that changed: how many windows now share this terminal.
   */
  broadcastControlState(host) {
    for (const clientId of host.clients) {
      const client = this.clients.get(clientId);
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
   * Close every existing session belonging to `deviceId` on `host`.
   *
   * Called just before a freshly authenticated connection is registered, so the
   * same physical device never occupies two client slots (and two PTYs) at once.
   */
  detachDeviceSessions(deviceId) {
    if (!deviceId) return 0;
    let closed = 0;
    for (const existing of [...this.clients.values()]) {
      if (!existing || existing.deviceId !== deviceId) continue;
      this.detachClient(existing, { notify: false, reason: 'device_revoked' });
      closeSocket(existing.ws, 1000, 'this device has been revoked by the relay operator');
      closed += 1;
    }
    return closed;
  }

  detachClient(client, { notify = true, reason = 'client_disconnected', closeCode = 1000, terminate = false } = {}) {
    if (!client || !this.clients.has(client.id)) return;
    this.clients.delete(client.id);
    const host = this.hosts.get(client.hostId);
    // Each window has its own PTY session. Tearing down the client immediately
    // stops its backing session on the host and cleans up its stream mapping.
    if (client.session) {
      const streamId = client.session.streamId;
      if (client.session.streamIndex !== null && client.session.streamIndex !== undefined && host) {
        host.streamIndices.delete(client.session.streamIndex);
      }
      this.streams.delete(streamId);
      if (host && isOpen(host.ws)) {
        jsonSend(host.ws, { type: 'session_stop', clientId: streamId, streamId });
      }
      client.session = null;
    }
    if (host) {
      host.clients.delete(client.id);
      this.notifyHostClientCount(host);
      this.broadcastControlState(host);
      if (host.clients.size === 0) {
        host.controllerId = null;
        if (host.reconnecting) this.detachHost(host, { notify: false, reason: 'no_clients' });
      }
    }
    const clientSocket = client.ws;
    client.ws = null;
    if (notify) jsonSend(clientSocket, { type: 'error', code: reason, message: reason === 'host_offline' ? 'Herdr host is offline' : 'connection closed' });
    if (terminate || clientSocket?.readyState === WebSocket.CLOSING) {
      terminateSocket(clientSocket);
    } else {
      closeSocket(clientSocket, closeCode, reason);
    }
    this.metrics.recordCleanup('closedPtysCleaned');
  }

  detachHost(host, { notify = true, reason = 'host_disconnected', terminate = false } = {}) {
    if (!host || this.hosts.get(host.id) !== host) return;
    if (host.reconnectTimer) clearTimeout(host.reconnectTimer);
    host.reconnectTimer = null;
    this.hosts.delete(host.id);
    for (const clientId of [...host.clients]) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      this.clients.delete(client.id);
      if (client.session) {
        if (client.session.streamIndex !== null && client.session.streamIndex !== undefined) {
          host.streamIndices.delete(client.session.streamIndex);
        }
        this.streams.delete(client.session.streamId);
        client.session = null;
      }
      const clientSocket = client.ws;
      client.ws = null;
      if (notify) jsonSend(clientSocket, { type: 'error', code: reason, message: 'Herdr host disconnected' });
      if (terminate || clientSocket?.readyState === WebSocket.CLOSING) {
        terminateSocket(clientSocket);
      } else {
        closeSocket(clientSocket, 1012, reason);
      }
    }
    host.clients.clear();
    this.metrics.forgetHost(host.id);
    const hostSocket = host.ws;
    host.ws = null;
    if (terminate || hostSocket?.readyState === WebSocket.CLOSING) {
      terminateSocket(hostSocket);
    } else {
      closeSocket(hostSocket, 1000, reason);
    }
  }

  heartbeat() {
    const sockets = [
      ...[...this.hosts.values()].map((host) => host.ws),
      ...[...this.clients.values()].map((client) => client.ws),
    ].filter((socket) => socket && socket.readyState !== WebSocket.CLOSED);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSING) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        terminateSocket(socket);
        continue;
      }
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!socket.isAlive) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        terminateSocket(socket);
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {}
    }
  }

  sweep() {
    const now = Date.now();
    const staleAfter = this.config.cleanup.staleAfterMs;
    for (const [key, attempt] of this.pairAttempts.entries()) {
      if (now - attempt.startedAt >= 60_000) this.pairAttempts.delete(key);
    }
    for (const [key, attempt] of this.clientHandshakeAttempts.entries()) {
      if (now - attempt.startedAt >= 60_000) this.clientHandshakeAttempts.delete(key);
    }
    for (const [key, attempt] of this.hostHandshakeAttempts.entries()) {
      if (now - attempt.startedAt >= 60_000) this.hostHandshakeAttempts.delete(key);
    }
    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeenAt > staleAfter) {
        this.metrics.recordCleanup('staleClientsPurged');
        this.detachClient(client, { notify: false, reason: 'stale_client', terminate: true });
      }
    }
    for (const host of [...this.hosts.values()]) {
      if (host.reconnecting) continue;
      if (now - host.lastSeenAt > staleAfter) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        this.detachHost(host, { notify: true, reason: 'stale_host', terminate: true });
      }
    }
    const authCleanup = this.auth.cleanup(now);
    if (authCleanup.removedDevices || authCleanup.removedPairings) this.metrics.recordCleanup('staleClientsPurged', authCleanup.removedDevices);
    this.metrics.cleanup.lastCleanupAt = new Date(now).toISOString();
  }

  statusSnapshot({ sample = true, includeDevices = false, scopeHostId = null } = {}) {
    const scopedClients = scopeHostId
      ? [...this.clients.values()].filter((client) => client.hostId === scopeHostId)
      : [...this.clients.values()];
    const scopedHosts = scopeHostId
      ? [...this.hosts.values()].filter((host) => host.id === scopeHostId)
      : [...this.hosts.values()];
    const clients = scopedClients.map((client) => ({
      id: client.id,
      role: client.role,
      ...(scopeHostId ? {} : { hostId: client.hostId }),
      ...(includeDevices ? { deviceId: client.deviceId } : {}),
      userAgent: client.userAgent,
      connectedAt: client.connectedAt,
      lastPingAt: client.lastPingAt,
      bytesReceived: client.bytesReceived,
      bytesSent: client.bytesSent,
      ip: client.ip,
    }));
    // The roster is read once and used twice: the operator response carries it
    // whole, and every response carries the per-host tally derived from it. A
    // public caller learns how many devices a workstation has paired, never
    // which ones.
    const pairedDevices = this.auth.listDevices();
    const pairedPerHost = new Map();
    for (const device of pairedDevices) {
      pairedPerHost.set(device.hostId, (pairedPerHost.get(device.hostId) || 0) + 1);
    }
    const hosts = scopedHosts.map((host) => ({
      id: host.id,
      hostname: host.hostname,
      platform: host.platform,
      arch: host.arch,
      status: host.reconnecting ? 'reconnecting' : host.clients.size ? 'busy' : 'online',
      connectedAt: host.connectedAt,
      activePtyCount: host.ptys.length,
      // Distinct devices attached to this workstation, not open sockets: a
      // phone with two tabs open is one device on the operator's board.
      connectedDeviceCount: countActiveUsers(
        [...host.clients].map((id) => this.clients.get(id)).filter(Boolean)
      ),
      pairedDeviceCount: pairedPerHost.get(host.id) || 0,
      load: host.load,
    }));
    // The workstation counts one PTY per stream and cannot know how many
    // windows are watching it; the relay does, and that is the number an
    // operator needs when the session is shared. Scoped callers only receive
    // the PTYs belonging to their authenticated host.
    const ptys = scopedHosts.flatMap((host) => host.ptys.map((pty) => ({
      ...pty,
      ...(scopeHostId ? {} : { hostId: host.id }),
      activeClients: host.clients.size,
    })));
    // The paired-device roster identifies people's hardware, so it is served to
    // the relay operator only — never on /api/status, which any paired device
    // may read.
    const devices = includeDevices ? pairedDevices : undefined;
    return {
      ...this.metrics.snapshot({
        clients,
        hosts,
        ptys,
        sample,
        scopeHostId,
        // Counted from the unredacted records: the mapped rows above only carry
        // `deviceId` for the operator, and a public caller must still see the
        // same number of users the operator does.
        activeUserCount: countActiveUsers(scopedClients),
      }),
      ...(devices ? { devices } : {}),
      relayMode: this.relayMode,
      isRemoteRelay: this.relayMode === 'remote',
      remoteAdminUrl: this.relayMode === 'remote'
        ? `${String(this.config.relay.publicUrl || '').replace(/\/+$/, '')}/admin`
        : undefined,
      relay: {
        mode: this.relayMode,
        publicUrl: this.config.relay.publicUrl,
        bind: this.config.relay.host,
        port: this.address()?.port || this.config.relay.port,
        maxClientsPerHost: this.config.relay.maxClientsPerHost,
        maxHosts: this.config.relay.maxHosts,
        maxPendingHandshakes: this.config.relay.maxPendingHandshakes,
        maxBufferedBytesPerClient: this.config.relay.maxBufferedBytesPerClient,
        hostReconnectGraceMs: this.config.relay.hostReconnectGraceMs,
        adminConfigured: Boolean(this.adminToken),
        adminStatusPath: '/api/admin/status',
        dashboardPath: '/admin',
      },
    };
  }

  clientAddress(req) {
    if (this.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket.remoteAddress || null;
  }
}

module.exports = { RelayServer, PROTOCOL_VERSION, VERSION };
