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
const { RelayMetrics } = require('./metrics');
const { unpackStreamFrame, packStreamFrame } = require('./stream-frame');
const { isWheelOnlyInput } = require('./scroll-input');
const { ensureDir } = require('./state');

const VERSION = require('../package.json').version;
const { PROTOCOL_VERSION } = require('./stream-frame');
const MAX_DIMENSION = 500;

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

class RelayServer {
  constructor(config = loadRelayConfig().config, options = {}) {
    this.config = config;
    this.relayMode = config.relay?.mode === 'local' ? 'local' : 'remote';
    this.hosts = new Map();
    this.clients = new Map();
    this.pairAttempts = new Map();
    this.startedAt = Date.now();
    this.metrics = options.metrics || new RelayMetrics({ version: VERSION, protocolVersion: PROTOCOL_VERSION });
    this.stateFile = options.stateFile || config.auth?.stateFile || path.join(defaultStateDir(), 'relay-auth.json');
    this.password = options.password ?? config.auth?.password ?? null;
    this.adminToken = options.adminToken ?? config.auth?.adminToken ?? null;
    this.trustProxy = Boolean(options.trustProxy ?? config.relay.trustProxy);
    this.auth = options.auth || new AuthStore({
      stateFile: this.stateFile,
      pairingTtlMs: config.auth.pairingTtlMs,
      deviceTtlMs: config.auth.deviceTtlMs,
      maxDevices: config.auth.maxDevices,
      password: this.password,
    });
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: config.relay.maxPayloadBytes });
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
    for (const client of [...this.clients.values()]) this.detachClient(client, { notify: false });
    for (const host of [...this.hosts.values()]) this.detachHost(host, { notify: false });
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
    this.wss.handleUpgrade(req, socket, head, (ws) => {
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
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

  allowPairAttempt(req) {
    const key = this.rateLimitKey(req);
    const now = Date.now();
    const current = this.pairAttempts.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.pairAttempts.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= 20) return false;
    current.count += 1;
    return true;
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin',
      });
      res.end();
      return;
    }
    if (!this.requestOriginAllowed(req)) {
      this.sendJsonResponse(res, 403, { ok: false, code: 'origin_denied', message: 'origin is not allowed' });
      return;
    }
    if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
      const snapshot = this.statusSnapshot({ sample: false });
      this.sendJsonResponse(res, 200, {
        ok: true,
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        hosts: snapshot.hostCount,
        clients: snapshot.clientCount,
        uptimeSeconds: snapshot.uptimeSeconds,
        load1m: snapshot.cpu.load1m,
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
      if (!this.authorizedHost(req) && !this.authorizedDevice(req)) {
        this.sendJsonResponse(res, 401, { ok: false, code: 'auth_required', message: 'an authorized device or host token is required' });
        return;
      }
      this.sendJsonResponse(res, 200, this.statusSnapshot());
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
      this.sendJsonResponse(res, 200, this.statusSnapshot());
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
      if (!this.hosts.has(hostId)) {
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
    ws.on('message', (raw, isBinary) => {
      if (!pending.authenticated) {
        if (isBinary) return this.rejectHandshake(ws, 'host hello must be JSON');
        const message = parseJson(raw.toString());
        if (!message || message.type !== 'host_hello' || message.protocol !== PROTOCOL_VERSION) return this.rejectHandshake(ws, 'invalid host hello');
        const registration = this.auth.registerHost(message.hostId, message.token, message.password ?? null);
        if (!registration.ok) return this.rejectHandshake(ws, registration.message, registration.code);
        clearTimeout(deadline);
        pending.authenticated = true;
        const oldHost = this.hosts.get(message.hostId);
        if (oldHost) this.detachHost(oldHost, { notify: true, reason: 'host_replaced' });
        const host = {
          id: message.hostId,
          ws,
          hostname: typeof message.hostname === 'string' ? message.hostname.slice(0, 128) : os.hostname(),
          platform: typeof message.platform === 'string' ? message.platform.slice(0, 32) : process.platform,
          arch: typeof message.arch === 'string' ? message.arch.slice(0, 32) : process.arch,
          connectedAt: new Date(pending.connectedAt).toISOString(),
          connectedAtMs: pending.connectedAt,
          lastSeenAt: Date.now(),
          clients: new Set(),
          controllerId: null,
          load: {},
          ptys: [],
        };
        pending.host = host;
        this.hosts.set(host.id, host);
        jsonSend(ws, { type: 'host_ready', protocol: PROTOCOL_VERSION, hostId: host.id });
        return;
      }
      this.handleHostMessage(pending.host, raw, isBinary);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (pending.host) this.detachHost(pending.host, { notify: true, reason: 'host_disconnected' });
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
      const client = this.clients.get(frame.streamId);
      if (frame.type !== 'output' || !client || client.hostId !== host.id) return;
      if (isOpen(client.ws)) {
        client.ws.send(frame.payload);
        client.bytesSent += frame.payload.length;
        this.metrics.recordOut(frame.payload.length);
      }
      return;
    }
    const message = parseJson(raw.toString());
    if (!message) return;
    if (message.type === 'heartbeat') {
      host.load = message.load && typeof message.load === 'object' ? message.load : {};
      host.ptys = Array.isArray(message.ptys) ? message.ptys.slice(0, 256) : [];
      return;
    }
    const client = typeof message.clientId === 'string' ? this.clients.get(message.clientId) : null;
    if (!client || client.hostId !== host.id) return;
    if (message.type === 'session_ready') {
      jsonSend(client.ws, { type: 'session_ready', clientId: client.id });
    } else if (message.type === 'session_exit') {
      jsonSend(client.ws, { type: 'exit', code: Number.isInteger(message.code) ? message.code : null });
      this.detachClient(client, { notify: false });
    } else if (message.type === 'error') {
      jsonSend(client.ws, { type: 'error', code: message.code || 'host_error', message: String(message.message || 'Host connector error') });
    }
  }

  handleClientConnection(ws, req) {
    const pending = { ws, req, authenticated: false };
    const deadline = setTimeout(() => {
      if (!pending.authenticated) closeSocket(ws, 1008, 'client hello timeout');
    }, 10000);
    ws.on('message', (raw, isBinary) => {
      if (!pending.authenticated) {
        if (isBinary) return this.rejectHandshake(ws, 'client hello must be JSON');
        const message = parseJson(raw.toString());
        if (!message || message.type !== 'hello' || message.protocol !== PROTOCOL_VERSION) return this.rejectHandshake(ws, 'invalid client hello');
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
        if (!host) return this.rejectHandshake(ws, 'paired Herdr host is offline', 'host_offline');
        if (host.clients.size >= this.config.relay.maxClientsPerHost) return this.rejectHandshake(ws, 'host client limit reached', 'too_many_clients');
        clearTimeout(deadline);
        const clientId = randomId('client');
        const client = {
          id: clientId,
          ws,
          hostId: host.id,
          deviceId: device.deviceId,
          role: host.controllerId ? 'viewer' : 'controller',
          controllerId: host.controllerId,
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
        if (client.role === 'controller') host.controllerId = client.id;
        client.controllerId = host.controllerId;
        pending.authenticated = true;
        pending.client = client;
        this.clients.set(client.id, client);
        host.clients.add(client.id);
        ws.isAlive = true;
        ws.on('pong', () => {
          ws.isAlive = true;
          client.lastSeenAt = Date.now();
          client.lastPingAt = new Date().toISOString();
        });
        if (paired) jsonSend(ws, { type: 'paired', token: paired.token, deviceId: paired.deviceId, hostId: paired.hostId, expiresAt: paired.expiresAtIso });
        // Expose the relay-assigned connection id so clients can distinguish
        // their own controller lease from another device's lease. The browser
        // supplied clientId identifies a device, not this live WebSocket.
        jsonSend(ws, { type: 'ready', role: client.role, controllerId: host.controllerId, hostId: host.id, clientId: client.id });
        jsonSend(host.ws, { type: 'session_start', clientId: client.id, streamId: client.id, cols: client.cols, rows: client.rows, role: client.role });
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
      // A read-only device may still scroll. Like `resize` below, scrolling is
      // not a shared-terminal action: each client drives its own PTY stream, so
      // a wheel report moves only that viewer's own screen. Everything else —
      // keystrokes, clicks, drags — stays behind the control lease.
      if (client.role !== 'controller' && !isWheelOnlyInput(raw)) {
        jsonSend(client.ws, { type: 'control_denied', message: 'this device is read-only' });
        return;
      }
      if (raw.length > this.config.relay.maxPayloadBytes) return;
      const frame = packStreamFrame('input', client.id, raw);
      if (isOpen(host.ws)) {
        host.ws.send(frame);
        client.bytesReceived += raw.length;
        this.metrics.recordIn(raw.length);
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
      // Every client drives its *own* PTY stream — `session_start` is emitted
      // per client with `streamId: client.id`, and the host resizes only that
      // session — so geometry is not a shared-terminal action and must not
      // require the control lease. Gating it here left a viewer's PTY at the
      // 80x24 it was opened with: the agent then painted into a grid the
      // terminal did not have, leaving blank rows under the content and
      // columns clipped off the right edge.
      client.cols = clampDimension(message.cols, client.cols);
      client.rows = clampDimension(message.rows, client.rows);
      jsonSend(host.ws, { type: 'resize', clientId: client.id, cols: client.cols, rows: client.rows });
    } else if (message.type === 'claim_control') {
      this.claimControl(host, client, Boolean(message.force));
    } else if (message.type === 'release_control') {
      if (host.controllerId === client.id) {
        host.controllerId = null;
        this.broadcastControlState(host);
      }
    }
  }

  claimControl(host, client, force) {
    if (host.controllerId === client.id) return jsonSend(client.ws, { type: 'control_granted' });
    if (host.controllerId && !force) return jsonSend(client.ws, { type: 'control_denied', message: 'another device currently controls this Herdr' });
    const previous = host.controllerId ? this.clients.get(host.controllerId) : null;
    if (previous) {
      previous.role = 'viewer';
      jsonSend(previous.ws, { type: 'control_revoked', controllerId: client.id });
    }
    host.controllerId = client.id;
    client.role = 'controller';
    jsonSend(client.ws, { type: 'control_granted' });
    this.broadcastControlState(host);
  }

  broadcastControlState(host) {
    for (const clientId of host.clients) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      client.role = host.controllerId === client.id ? 'controller' : 'viewer';
      client.controllerId = host.controllerId;
      jsonSend(client.ws, { type: 'control_state', role: client.role, controllerId: host.controllerId || null });
    }
  }

  detachClient(client, { notify = true, reason = 'client_disconnected' } = {}) {
    if (!client || !this.clients.has(client.id)) return;
    this.clients.delete(client.id);
    const host = this.hosts.get(client.hostId);
    if (host) {
      host.clients.delete(client.id);
      if (isOpen(host.ws)) jsonSend(host.ws, { type: 'session_stop', clientId: client.id });
      const wasController = host.controllerId === client.id;
      if (wasController) {
        host.controllerId = null;
        const next = [...host.clients]
          .map((id) => this.clients.get(id))
          .filter(Boolean)
          .sort((a, b) => a.connectedAtMs - b.connectedAtMs)[0];
        if (next) {
          host.controllerId = next.id;
          next.role = 'controller';
          jsonSend(next.ws, { type: 'control_granted' });
        }
        this.broadcastControlState(host);
      }
    }
    if (notify) jsonSend(client.ws, { type: 'error', code: reason, message: reason === 'host_offline' ? 'Herdr host is offline' : 'connection closed' });
    closeSocket(client.ws, 1000, reason);
    this.metrics.recordCleanup('closedPtysCleaned');
  }

  detachHost(host, { notify = true, reason = 'host_disconnected' } = {}) {
    if (!host || this.hosts.get(host.id) !== host) return;
    this.hosts.delete(host.id);
    for (const clientId of [...host.clients]) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      this.clients.delete(client.id);
      if (notify) jsonSend(client.ws, { type: 'error', code: reason, message: 'Herdr host disconnected' });
      closeSocket(client.ws, 1012, reason);
    }
    host.clients.clear();
    closeSocket(host.ws, 1000, reason);
  }

  heartbeat() {
    const sockets = [
      ...[...this.hosts.values()].map((host) => host.ws),
      ...[...this.clients.values()].map((client) => client.ws),
    ];
    for (const socket of sockets) {
      if (!socket.isAlive) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        closeSocket(socket, 1001, 'heartbeat timeout');
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
    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeenAt > staleAfter) {
        this.metrics.recordCleanup('staleClientsPurged');
        this.detachClient(client, { notify: false, reason: 'stale_client' });
      }
    }
    for (const host of [...this.hosts.values()]) {
      if (now - host.lastSeenAt > staleAfter) {
        this.metrics.recordCleanup('deadConnectionsClosed');
        this.detachHost(host, { notify: true, reason: 'stale_host' });
      }
    }
    const authCleanup = this.auth.cleanup(now);
    if (authCleanup.removedDevices || authCleanup.removedPairings) this.metrics.recordCleanup('staleClientsPurged', authCleanup.removedDevices);
    this.metrics.cleanup.lastCleanupAt = new Date(now).toISOString();
  }

  statusSnapshot({ sample = true } = {}) {
    const clients = [...this.clients.values()].map((client) => ({
      id: client.id,
      role: client.role,
      hostId: client.hostId,
      deviceId: client.deviceId,
      userAgent: client.userAgent,
      connectedAt: client.connectedAt,
      lastPingAt: client.lastPingAt,
      bytesReceived: client.bytesReceived,
      bytesSent: client.bytesSent,
      ip: client.ip,
    }));
    const hosts = [...this.hosts.values()].map((host) => ({
      id: host.id,
      hostname: host.hostname,
      platform: host.platform,
      arch: host.arch,
      status: host.clients.size ? 'busy' : 'online',
      connectedAt: host.connectedAt,
      activePtyCount: host.ptys.length,
      load: host.load,
    }));
    const ptys = [...this.hosts.values()].flatMap((host) => host.ptys.map((pty) => ({ ...pty, hostId: host.id })));
    return {
      ...this.metrics.snapshot({ clients, hosts, ptys, sample }),
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
