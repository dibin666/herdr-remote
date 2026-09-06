'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { loadConfig, hostWebSocketUrl, resolveHostRelayUrl } = require('./config');
const { resolveSocketPath, inspectSocket } = require('./socket-discovery');
const { PtySession } = require('./pty-session');
const { resolveHerdrCommand } = require('./herdr-command');
// The wire format lives in the relay package so both ends of the protocol are
// generated from one definition.
const { packStreamFrame, unpackStreamFrame, PROTOCOL_VERSION } = require('herdr-remote-relay/protocol');
const { resolveHostPalette } = require('./terminal-palette');
const { EXIT_REPLACED } = require('./exit-codes');

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(9).toString('base64url')}`;
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(1000, 'host connector stopping'); } catch {}
}

class HostConnector {
  constructor(options = {}) {
    const config = options.config || loadConfig();
    this.config = config;
    this.relayUrl = options.relayUrl
      || (process.env.RELAY_URL ? hostWebSocketUrl(process.env.RELAY_URL) : resolveHostRelayUrl(config));
    this.hostId = options.hostId || process.env.RELAY_HOST_ID || randomId('host');
    this.hostToken = options.hostToken || process.env.RELAY_HOST_TOKEN || '';
    // Optional; a relay without a password accepts any workstation.
    this.relayPassword = options.relayPassword ?? process.env.RELAY_PASSWORD ?? '';
    this.socketPath = options.socketPath || resolveSocketPath(config.herdr.socketPath);
    this.herdrCommand = options.herdrCommand || resolveHerdrCommand();
    this.herdrArgs = options.herdrArgs || config.herdr.args;
    this.cwd = options.cwd || config.herdr.cwd;
    /**
     * What the workstation's own terminal looks like. A browser has no way to
     * know it — the PTY carries color indices, not colors — so the host reports
     * it and the browser renders the session the way the workstation sees it.
     * Normally captured by the start path that still had a terminal and passed
     * down in the environment; `null` when nobody could ask.
     */
    this.terminalPalette = options.terminalPalette !== undefined
      ? options.terminalPalette
      : resolveHostPalette();
    this.ws = null;
    this.sessions = new Map();
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
  }

  start() {
    if (!this.hostToken) {
      throw new Error('RELAY_HOST_TOKEN is required');
    }
    this.stopping = false;
    this.connect();
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.destroySessions();
    closeSocket(this.ws);
    this.ws = null;
  }

  connect() {
    if (this.stopping || (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState))) return;
    let ws;
    try {
      ws = new WebSocket(this.relayUrl);
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    this.ws = ws;
    ws.isAlive = true;
    ws.on('open', () => {
      this.reconnectAttempts = 0;
      ws.isAlive = true;
      sendJson(ws, {
        type: 'host_hello',
        protocol: PROTOCOL_VERSION,
        hostId: this.hostId,
        token: this.hostToken,
        password: this.relayPassword || null,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        terminalPalette: this.terminalPalette || null,
      });
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.cleanup.heartbeatIntervalMs);
    });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw, isBinary) => this.handleMessage(raw, isBinary));
    ws.on('close', (code, rawReason) => {
      if (this.ws === ws) this.ws = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.destroySessions();

      // Another connector has claimed this workstation. Reconnecting would just
      // displace it in turn, and each swap drops every attached browser, so
      // stand down instead of fighting for the slot.
      const reason = rawReason ? rawReason.toString() : '';
      if (reason === 'host_replaced') {
        this.stopping = true;
        process.stderr.write('herdr-remote host connector: another instance took over this workstation; exiting\n');
        this.stop();
        process.exit(EXIT_REPLACED);
      }
      this.scheduleReconnect();
    });
    ws.on('error', (error) => {
      process.stderr.write(`herdr-remote host connector: ${error.message}\n`);
    });
  }

  scheduleReconnect(error = null) {
    if (this.stopping || this.reconnectTimer) return;
    if (error) process.stderr.write(`herdr-remote host connector: ${error.message}\n`);
    const delay = Math.min(30000, 500 * (1.5 ** this.reconnectAttempts) + Math.floor(Math.random() * 250));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleMessage(raw, isBinary) {
    if (isBinary) {
      let frame;
      try {
        frame = unpackStreamFrame(raw);
      } catch (error) {
        process.stderr.write(`herdr-remote host connector: invalid relay frame: ${error.message}\n`);
        return;
      }
      if (frame.type === 'input') this.sessions.get(frame.streamId)?.pty.write(frame.payload);
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
    // A relay-level error (no clientId) is a rejected handshake — a wrong relay
    // password, or a host token the relay does not recognise. Without this the
    // connection just closed silently and reconnected forever, leaving the user
    // with an empty log and no idea what was wrong.
    if (message.type === 'error' && !message.clientId) {
      process.stderr.write(`herdr-remote host connector: relay rejected the connection: ${message.message || message.code}\n`);
      return;
    }
    if (message.type === 'session_start') this.startSession(message);
    else if (message.type === 'session_stop') this.stopSession(message.clientId || message.streamId);
    else if (message.type === 'resize') this.resizeSession(message);
  }

  startSession(message) {
    const streamId = typeof message.streamId === 'string' ? message.streamId : message.clientId;
    if (!streamId) return;
    this.stopSession(streamId);
    const socketInfo = inspectSocket(this.socketPath);
    if (!socketInfo.ok) {
      sendJson(this.ws, { type: 'error', clientId: streamId, code: 'herdr_socket_unavailable', message: socketInfo.reason });
      return;
    }
    const pty = new PtySession({
      command: this.herdrCommand,
      args: this.herdrArgs,
      cwd: this.cwd,
      socketPath: this.socketPath,
    });
    const session = {
      id: streamId,
      pty,
      cols: Number(message.cols) || PtySession.DEFAULT_COLS,
      rows: Number(message.rows) || PtySession.DEFAULT_ROWS,
      createdAt: new Date().toISOString(),
      clientId: streamId,
    };
    try {
      pty.start({
        cols: session.cols,
        rows: session.rows,
        onData: (data) => {
          const payload = Buffer.from(data, 'utf8');
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(packStreamFrame('output', streamId, payload));
        },
        onExit: ({ exitCode }) => {
          if (this.sessions.get(streamId) !== session) return;
          this.sessions.delete(streamId);
          sendJson(this.ws, { type: 'session_exit', clientId: streamId, code: exitCode });
          this.sendHeartbeat();
        },
      });
    } catch (error) {
      sendJson(this.ws, { type: 'error', clientId: streamId, code: 'pty_start_failed', message: error.message });
      pty.kill();
      return;
    }
    this.sessions.set(streamId, session);
    sendJson(this.ws, { type: 'session_ready', clientId: streamId });
    this.sendHeartbeat();
  }

  stopSession(streamId) {
    const session = this.sessions.get(streamId);
    if (!session) return;
    this.sessions.delete(streamId);
    session.pty.kill();
    this.sendHeartbeat();
  }

  resizeSession(message) {
    const id = message.clientId || message.streamId;
    const session = this.sessions.get(id);
    if (!session) return;
    session.cols = Number.isInteger(message.cols) ? Math.min(500, Math.max(2, message.cols)) : session.cols;
    session.rows = Number.isInteger(message.rows) ? Math.min(500, Math.max(2, message.rows)) : session.rows;
    session.pty.resize(session.cols, session.rows);
  }

  destroySessions() {
    for (const session of this.sessions.values()) session.pty.kill();
    this.sessions.clear();
  }

  sendHeartbeat() {
    const memory = process.memoryUsage();
    const load = os.loadavg();
    sendJson(this.ws, {
      type: 'heartbeat',
      load: {
        load1m: load[0] || 0,
        load5m: load[1] || 0,
        load15m: load[2] || 0,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      ptys: [...this.sessions.values()].map((session) => ({
        id: session.id,
        pid: session.pty.terminal?.pid || null,
        command: session.pty.command,
        cols: session.cols,
        rows: session.rows,
        cwd: session.pty.cwd,
        createdAt: session.createdAt,
        activeClients: 1,
      })),
    });
  }
}

if (require.main === module) {
  const connector = new HostConnector();
  try {
    connector.start();
  } catch (error) {
    process.stderr.write(`herdr-remote host connector failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  const stop = () => { connector.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { HostConnector, PROTOCOL_VERSION };
