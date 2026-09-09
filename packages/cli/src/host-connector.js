'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { loadConfig, hostWebSocketUrl, resolveHostRelayUrl, stateDir } = require('./config');
const { ensureDir } = require('./state');
const { resolveSocketPath, inspectSocket } = require('./socket-discovery');
const { PtySession } = require('./pty-session');
const { resolveHerdrCommand, verifyHerdrCommand, herdrNotFoundMessage } = require('./herdr-command');
// The wire format lives in the relay package so both ends of the protocol are
// generated from one definition.
const { packStreamFrame, unpackStreamFrame, PROTOCOL_VERSION } = require('herdr-remote-relay/protocol');
const { resolveHostPalette } = require('./terminal-palette');
const { EXIT_REPLACED, EXIT_AUTH_FAILED } = require('./exit-codes');

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(9).toString('base64url')}`;
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function closeSocket(ws, reason = 'host connector stopping') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(1000, reason); } catch {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class HostConnector {
  /**
   * A session that dies this fast never really started. Anything longer is a
   * session the user actually used and then left.
   */
  static FAST_FAILURE_MS = 1500;
  /** How many broken starts in a row before we stop calling them exits. */
  static FAST_FAILURE_LIMIT = 3;

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
    // Where to look for Herdr when the command has to be resolved again; the
    // real environment unless a caller narrows it.
    this.herdrLookup = options.herdrLookup || {};
    this.herdrCommand = options.herdrCommand || resolveHerdrCommand(this.herdrLookup);
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
    this.fastFailures = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.clientCount = 0;
    this.legacyHeartbeat = false;
    this.ready = false;
    this.authFailure = false;
    this.stopping = false;
    this.lockPath = options.lockPath
      || process.env.HERDR_REMOTE_HOST_LOCK
      || path.join(stateDir(), 'host-connector.lock');
    this.lockFd = null;
  }

  acquireLock() {
    if (this.lockFd !== null) return;
    ensureDir(path.dirname(this.lockPath));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, hostId: this.hostId, startedAt: new Date().toISOString() })}\n`);
        this.lockFd = fd;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch {}
        if (owner && pidAlive(owner.pid)) {
          const duplicate = new Error(`another host connector is already running (pid ${owner.pid})`);
          duplicate.code = 'HOST_ALREADY_RUNNING';
          throw duplicate;
        }
        try { fs.rmSync(this.lockPath, { force: true }); } catch {}
      }
    }
    const stale = new Error('could not acquire host connector lock');
    stale.code = 'HOST_LOCK_FAILED';
    throw stale;
  }

  releaseLock() {
    const owned = this.lockFd !== null;
    if (this.lockFd !== null) {
      try { fs.closeSync(this.lockFd); } catch {}
      this.lockFd = null;
    }
    if (!owned) return;
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (owner.pid !== process.pid) return;
    } catch {}
    try { fs.rmSync(this.lockPath, { force: true }); } catch {}
  }

  start() {
    if (!this.hostToken) {
      throw new Error('RELAY_HOST_TOKEN is required');
    }
    this.acquireLock();
    this.stopping = false;
    this.connect();
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    sendJson(this.ws, { type: 'host_shutdown' });
    this.destroySessions();
    closeSocket(this.ws, 'host_shutdown');
    this.ws = null;
    this.ready = false;
    this.clientCount = 0;
    this.legacyHeartbeat = false;
    this.releaseLock();
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
      ws.isAlive = true;
      this.ready = false;
      this.authFailure = false;
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
        capabilities: ['host_handoff', 'idle_heartbeat'],
      });
      // The relay sends host_ready with the current browser count. No business
      // heartbeat is started until that message says somebody is watching.
    });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw, isBinary) => this.handleMessage(raw, isBinary));
    ws.on('close', (code, rawReason) => {
      // A replacement socket may be live while an older socket is still
      // delivering its close event. Never let that stale event destroy the new
      // session or clear its heartbeat timer.
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.ready = false;
      this.clientCount = 0;
      this.legacyHeartbeat = false;
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
      if (this.authFailure) {
        this.stopping = true;
        process.stderr.write('herdr-remote host connector: authentication failed; update relay credentials and restart the service\n');
        this.releaseLock();
        process.exit(EXIT_AUTH_FAILED);
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
      this.authFailure = ['relay_password_required', 'host_auth_failed', 'invalid_host_credentials'].includes(message.code);
      process.stderr.write(`herdr-remote host connector: relay rejected the connection: ${message.message || message.code}\n`);
      return;
    }
    if (message.type === 'host_ready') {
      this.ready = true;
      this.reconnectAttempts = 0;
      if (Object.hasOwn(message, 'clientCount')) {
        this.legacyHeartbeat = false;
        this.setClientCount(message.clientCount);
      } else {
        // An older relay does not know client_count. Keep its historical
        // telemetry behavior so rolling upgrades do not silently lose status.
        this.legacyHeartbeat = true;
        this.sendHeartbeat(true);
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.cleanup.heartbeatIntervalMs);
      }
      return;
    }
    if (message.type === 'client_count') {
      this.setClientCount(message.clientCount);
      return;
    }
    if (message.type === 'session_start') this.startSession(message);
    else if (message.type === 'session_stop') this.stopSession(message.clientId || message.streamId);
    else if (message.type === 'resize') this.resizeSession(message);
  }

  /**
   * Confirm Herdr is really there before the name reaches `pty.spawn`.
   *
   * node-pty resolves the command with `execvp(3)` inside the forked child, so
   * a missing binary is not a spawn error anyone can catch: the child writes
   * "execvp(3) failed.: No such file or directory" into the PTY and exits. The
   * `session_exit` that follows makes the relay drop the browser's socket, the
   * browser reconnects into the same broken start, and that is the reconnect
   * loop of issue #1. Refusing to start keeps the socket up and puts the actual
   * reason in front of the user.
   *
   * Re-resolved per session rather than cached from the constructor: a service
   * that started before Herdr was installed should pick it up without a restart.
   */
  ensureHerdrCommand() {
    const resolved = verifyHerdrCommand(this.herdrCommand, this.herdrLookup);
    if (resolved.found) {
      this.herdrCommand = resolved.command;
      return null;
    }
    return herdrNotFoundMessage(this.herdrLookup);
  }

  startSession(message) {
    const streamId = typeof message.streamId === 'string' ? message.streamId : message.clientId;
    if (!streamId) return;
    this.stopSession(streamId);
    const missingHerdr = this.ensureHerdrCommand();
    if (missingHerdr) {
      process.stderr.write(`herdr-remote host connector: ${missingHerdr}\n`);
      sendJson(this.ws, { type: 'error', clientId: streamId, code: 'herdr_not_found', message: missingHerdr });
      return;
    }
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
      startedAtMs: Date.now(),
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
          this.reportSessionExit(session, exitCode);
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

  /**
   * Tell the relay how a session ended.
   *
   * `session_exit` is the honest answer for a session that ran, and the relay
   * closes the browser's socket on it so the window can start a fresh one. That
   * is also what turns a start that keeps failing into a reconnect loop: exit,
   * close, reconnect, exit. Once a few starts in a row have died immediately
   * with a non-zero code the failure is systemic, not a session ending, so it is
   * reported as an error — which the relay forwards without dropping the socket,
   * leaving the user with a message instead of a spinner.
   */
  reportSessionExit(session, exitCode) {
    const streamId = session.id;
    const lifetimeMs = Date.now() - session.startedAtMs;
    const failedFast = exitCode !== 0 && lifetimeMs < HostConnector.FAST_FAILURE_MS;
    this.fastFailures = failedFast ? this.fastFailures + 1 : 0;
    if (this.fastFailures < HostConnector.FAST_FAILURE_LIMIT) {
      sendJson(this.ws, { type: 'session_exit', clientId: streamId, code: exitCode });
      return;
    }
    const message = `"${this.herdrCommand}" exited immediately with code ${exitCode} on ${this.fastFailures} attempts in a row. `
      + 'Check that it runs from a terminal, and see the host connector log for what it printed.';
    process.stderr.write(`herdr-remote host connector: ${message}\n`);
    sendJson(this.ws, { type: 'error', clientId: streamId, code: 'herdr_start_failed', message });
  }

  stopSession(streamId) {
    const session = this.sessions.get(streamId);
    if (!session) return;
    this.sessions.delete(streamId);
    session.pty.kill();
    this.sendHeartbeat();
  }

  setClientCount(value) {
    const next = Number.isInteger(value) ? Math.max(0, value) : 0;
    if (next === this.clientCount && (next === 0 || this.heartbeatTimer)) return;
    const wasActive = this.clientCount > 0;
    this.clientCount = next;
    if (next > 0) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.sendHeartbeat(true);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.cleanup.heartbeatIntervalMs);
    } else {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (wasActive) this.sendHeartbeat(true);
    }
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

  sendHeartbeat(force = false) {
    if (!force && this.clientCount <= 0 && !this.legacyHeartbeat) return;
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
    process.exitCode = error.code === 'HOST_ALREADY_RUNNING' ? EXIT_REPLACED : 1;
  }
  const stop = () => { connector.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { HostConnector, PROTOCOL_VERSION };
