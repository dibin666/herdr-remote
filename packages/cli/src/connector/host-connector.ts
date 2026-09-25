// The workstation's link to the relay: connect and reconnect, say hello, keep
// the socket alive, report load while someone watches, and hand each relay
// message to the part of the connector that owns it.

import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY,
  PROTOCOL_VERSION,
  type RelayToHostMessage,
  unpackStreamFrame,
} from 'herdr-remote-relay/protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { type Config, loadConfig } from '../config.js';
import { EXIT_AUTH_FAILED, EXIT_REPLACED } from '../exit-codes.js';
import { cleanPastedDir, savePastedFile } from '../pasted-files.js';
import { stateDir } from '../paths.js';
import { hostWebSocketUrl, resolveHostRelayUrl } from '../relay-urls.js';
import { resolveSocketPath } from '../socket-discovery.js';
import { resolveHostPalette } from '../terminal-palette.js';
import { randomToken } from 'herdr-remote-relay/state';
import { AgentWatch, type AgentWatchOptions } from './agent-watch.js';
import { FontServer, type FontServerOptions } from './font-server.js';
import { acquireHostLock, releaseHostLock } from './lock.js';
import { Sessions, type SessionsOptions } from './sessions.js';
import { UpdateReport, type UpdateReportOptions } from './update-report.js';
import { closeSocket, type HostSocket, sendJson, streamOf, terminateSocket } from './wire.js';

/** Handshake errors that no reconnect can fix. */
const AUTH_ERROR_CODES = [
  'relay_password_required',
  'host_auth_failed',
  'invalid_host_credentials',
];

export type HostConnectorOptions = Partial<
  Omit<SessionsOptions, 'herdrArgs' | 'cwd' | 'herdrLogPath' | 'socketPath'>
> &
  FontServerOptions &
  Omit<AgentWatchOptions, 'socketPath'> &
  UpdateReportOptions & {
    config?: Config;
    relayUrl?: string;
    hostId?: string;
    hostToken?: string;
    relayPassword?: string;
    socketPath?: string;
    herdrArgs?: string[];
    cwd?: string;
    herdrLogPath?: string;
    terminalPalette?: unknown;
    lockPath?: string;
    /**
     * Called when the connector must end its process: replaced by another
     * instance, or refused by the relay. The entry point exits with the code.
     */
    onFatal?: (exitCode: number) => void;
  };

export class HostConnector {
  readonly config: Config;
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostToken: string;
  private readonly relayPassword: string;
  readonly socketPath: string;
  /**
   * What the workstation's own terminal looks like. A browser has no way to
   * know it — the PTY carries color indices, not colors — so the host reports
   * it and the browser renders the session the way the workstation sees it.
   * Normally captured by the start path that still had a terminal and passed
   * down in the environment; `null` when nobody could ask.
   */
  private readonly terminalPalette: unknown;
  readonly sessions: Sessions;
  readonly font: FontServer;
  readonly agents: AgentWatch;
  readonly updates: UpdateReport;
  ws: HostSocket | null = null;
  reconnectTimer: NodeJS.Timeout | null = null;
  heartbeatTimer: NodeJS.Timeout | null = null;
  keepaliveTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private clientCount = 0;
  /** The relay predates `client_count`; report load all the time, as it expects. */
  private legacyHeartbeat = false;
  private authFailure = false;
  stopping = false;
  readonly lockPath: string;
  private lockFd: number | null = null;
  private readonly onFatal: (exitCode: number) => void;

  constructor(options: HostConnectorOptions = {}) {
    const config = options.config || loadConfig();
    this.config = config;
    this.relayUrl =
      options.relayUrl ||
      (process.env.RELAY_URL
        ? hostWebSocketUrl(process.env.RELAY_URL)
        : resolveHostRelayUrl(config));
    this.hostId = options.hostId || process.env.RELAY_HOST_ID || `host-${randomToken(9)}`;
    this.hostToken = options.hostToken || process.env.RELAY_HOST_TOKEN || '';
    // Optional; a relay without a password accepts any workstation.
    this.relayPassword = options.relayPassword ?? process.env.RELAY_PASSWORD ?? '';
    this.socketPath = options.socketPath || resolveSocketPath(config.herdr.socketPath);
    this.terminalPalette =
      options.terminalPalette !== undefined ? options.terminalPalette : resolveHostPalette();
    const send = (payload: unknown) => sendJson(this.ws, payload);
    this.sessions = new Sessions(
      {
        ...options,
        socketPath: this.socketPath,
        herdrArgs: options.herdrArgs || config.herdr.args,
        cwd: options.cwd || config.herdr.cwd,
        herdrLogPath: options.herdrLogPath || path.join(stateDir(), 'herdr-server.log'),
      },
      {
        send,
        sendFrame: (frame) => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
        },
        changed: () => this.sendHeartbeat(),
      },
    );
    this.font = new FontServer(options, send);
    this.agents = new AgentWatch({ ...options, socketPath: this.socketPath }, send);
    this.updates = new UpdateReport(options, send);
    this.lockPath =
      options.lockPath ||
      process.env.HERDR_REMOTE_HOST_LOCK ||
      path.join(stateDir(), 'host-connector.lock');
    this.onFatal = options.onFatal || ((exitCode) => process.exit(exitCode));
    try {
      cleanPastedDir();
    } catch {
      // Old pastes are tidied again next start; a connector must still come up.
    }
  }

  acquireLock(): void {
    if (this.lockFd !== null) return;
    this.lockFd = acquireHostLock(this.lockPath, this.hostId);
  }

  releaseLock(): void {
    if (this.lockFd === null) return;
    releaseHostLock(this.lockPath, this.lockFd);
    this.lockFd = null;
  }

  start(): void {
    if (!this.hostToken) {
      throw new Error('RELAY_HOST_TOKEN is required');
    }
    this.acquireLock();
    this.stopping = false;
    this.connect();
    // Off unless the user switched it on: Herdr is theirs to start.
    if (this.config.herdr?.autoStart) {
      this.sessions.startHerdr().catch((error) => {
        process.stderr.write(
          `herdr-remote host connector: could not start Herdr: ${error.message}\n`,
        );
      });
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    sendJson(this.ws, { type: 'host_shutdown' });
    this.disconnected();
    closeSocket(this.ws, 'host_shutdown');
    this.ws = null;
    this.releaseLock();
  }

  /** Forget everything that lived on the relay connection. */
  private disconnected(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.stopKeepalive();
    // Nothing to report to, so stop asking Herdr. A reconnect brings the
    // watcher back with the relay's next client count.
    this.agents.stop();
    this.clientCount = 0;
    this.legacyHeartbeat = false;
    this.sessions.stopAll();
  }

  connect(): void {
    if (
      this.stopping ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return;
    this.stopKeepalive();
    let ws: HostSocket;
    try {
      ws = new WebSocket(this.relayUrl);
    } catch (error) {
      this.scheduleReconnect(error as Error);
      return;
    }
    this.ws = ws;
    ws.isAlive = true;
    ws.on('open', () => {
      // Disable Nagle's algorithm to prevent small frames from stalling ~40ms when delayed ACK is active.
      try {
        (ws as unknown as { _socket?: { setNoDelay(on: boolean): void } })._socket?.setNoDelay(
          true,
        );
      } catch {}
      ws.isAlive = true;
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
        terminalFont: this.font.publicFont(),
        capabilities: [CAPABILITY.hostHandoff, CAPABILITY.idleHeartbeat, CAPABILITY.binaryFrameV2],
      });
      // The relay sends host_ready with the current browser count. No business
      // heartbeat is started until that message says somebody is watching.
    });
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw: RawData, isBinary: boolean) => this.handleMessage(raw, isBinary));
    ws.on('close', (_code: number, rawReason: Buffer) => {
      // A replacement socket may be live while an older socket is still
      // delivering its close event. Never let that stale event destroy the new
      // session or clear its heartbeat timer.
      if (this.ws !== ws) return;
      this.ws = null;
      this.disconnected();

      // Another connector has claimed this workstation. Reconnecting would just
      // displace it in turn, and each swap drops every attached browser, so
      // stand down instead of fighting for the slot.
      const reason = rawReason ? rawReason.toString() : '';
      if (reason === 'host_replaced') {
        process.stderr.write(
          'herdr-remote host connector: another instance took over this workstation; exiting\n',
        );
        this.stop();
        this.onFatal(EXIT_REPLACED);
        return;
      }
      if (this.authFailure) {
        this.stopping = true;
        process.stderr.write(
          'herdr-remote host connector: authentication failed; update relay credentials and restart the service\n',
        );
        this.releaseLock();
        this.onFatal(EXIT_AUTH_FAILED);
        return;
      }
      this.scheduleReconnect();
    });
    ws.on('error', (error: Error) => {
      process.stderr.write(`herdr-remote host connector: ${error.message}\n`);
    });
  }

  scheduleReconnect(error: Error | null = null): void {
    if (this.stopping || this.reconnectTimer) return;
    if (error) process.stderr.write(`herdr-remote host connector: ${error.message}\n`);
    const delay = Math.min(
      30_000,
      500 * 1.5 ** this.reconnectAttempts + Math.floor(Math.random() * 250),
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleMessage(raw: RawData | string, isBinary = false): Promise<void> | undefined {
    if (isBinary) {
      this.handleFrame(raw as Buffer);
      return undefined;
    }
    let message: RelayToHostMessage;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'));
    } catch {
      // Not JSON: nothing a relay speaking this protocol would send.
      return undefined;
    }
    switch (message.type) {
      case 'error':
        // A relay-level error (no clientId) is a rejected handshake — a wrong
        // relay password, or a host token the relay does not recognise. Without
        // this the connection just closed silently and reconnected forever,
        // leaving the user with an empty log and no idea what was wrong.
        if ((message as { clientId?: string }).clientId) return undefined;
        this.authFailure = AUTH_ERROR_CODES.includes(message.code);
        process.stderr.write(
          `herdr-remote host connector: relay rejected the connection: ${message.message || message.code}\n`,
        );
        return undefined;
      case 'host_ready':
        this.hostReady(message);
        return undefined;
      case 'client_count':
        this.setClientCount(message.clientCount);
        return undefined;
      case 'session_start':
        return this.startSession(message);
      case 'herdr_start':
        return this.sessions.startHerdrFor(streamOf(message));
      case 'session_stop': {
        const streamId = streamOf(message);
        if (streamId) this.sessions.stop(streamId);
        return undefined;
      }
      case 'resize':
        this.sessions.resize(message);
        return undefined;
      case 'paste_file':
        this.savePaste(streamOf(message), message);
        return undefined;
      case 'host_font_chunk_request':
        this.font.sendChunk(streamOf(message), message);
        return undefined;
      case 'host_font_subset_request':
        this.font.sendSubset(streamOf(message), message);
        return undefined;
      case 'host_font_refresh':
        this.font.refresh();
        return undefined;
      default:
        return undefined;
    }
  }

  private handleFrame(raw: Buffer): void {
    let frame: ReturnType<typeof unpackStreamFrame>;
    try {
      frame = unpackStreamFrame(raw);
    } catch (error) {
      process.stderr.write(
        `herdr-remote host connector: invalid relay frame: ${(error as Error).message}\n`,
      );
      return;
    }
    if (frame.type !== 'input') return;
    this.sessions.write(
      frame.version === 2 ? { streamIndex: frame.streamIndex } : { streamId: frame.streamId },
      frame.payload,
    );
  }

  private hostReady(message: { clientCount?: number }): void {
    this.reconnectAttempts = 0;
    this.startKeepalive();
    if (Object.hasOwn(message, 'clientCount')) {
      this.legacyHeartbeat = false;
      this.setClientCount(message.clientCount);
      return;
    }
    // An older relay does not know client_count. Keep its historical
    // telemetry behavior so rolling upgrades do not silently lose status.
    this.legacyHeartbeat = true;
    this.sendHeartbeat(true);
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      this.config.cleanup.heartbeatIntervalMs,
    );
  }

  startSession(message: Parameters<Sessions['start']>[0]): Promise<void> | undefined {
    if (!streamOf(message)) return undefined;
    // A window opening is when a person is looking; that is when to ask.
    this.updates.report();
    this.font.pickUp();
    return this.sessions.start(message);
  }

  private savePaste(streamId: string | null, message: { mime: string; dataBase64: string }): void {
    try {
      const savedPath = savePastedFile({ mime: message.mime, dataBase64: message.dataBase64 });
      sendJson(this.ws, { type: 'paste_file_ready', clientId: streamId, path: savedPath });
    } catch (error) {
      sendJson(this.ws, {
        type: 'error',
        clientId: streamId,
        code: 'paste_file_write_failed',
        message: (error as Error).message || 'Failed to save pasted file',
      });
    }
  }

  startKeepalive(): void {
    this.stopKeepalive();
    if (!this.ws || this.stopping) return;
    this.ws.isAlive = true;
    const interval = this.config?.cleanup?.heartbeatIntervalMs || 30_000;
    this.keepaliveTimer = setInterval(() => this.tickKeepalive(), interval);
  }

  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  tickKeepalive(): void {
    const ws = this.ws;
    if (!ws || this.stopping) return;
    if (ws.readyState === WebSocket.CLOSING) {
      terminateSocket(ws);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!ws.isAlive) {
      terminateSocket(ws);
      return;
    }
    ws.isAlive = false;
    try {
      if (typeof ws.ping === 'function') ws.ping();
    } catch {}
    if (this.clientCount <= 0 && !this.legacyHeartbeat) {
      sendJson(ws, { type: 'heartbeat', load: {}, ptys: [] });
    }
  }

  setClientCount(value: unknown): void {
    const next = Number.isInteger(value) ? Math.max(0, value as number) : 0;
    if (next === this.clientCount && (next === 0 || this.heartbeatTimer)) return;
    const wasActive = this.clientCount > 0;
    this.clientCount = next;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (next > 0) {
      this.sendHeartbeat(true);
      this.heartbeatTimer = setInterval(
        () => this.sendHeartbeat(),
        this.config.cleanup.heartbeatIntervalMs,
      );
    } else if (wasActive) {
      this.sendHeartbeat(true);
    }
    // Nobody watching, nothing to ask Herdr about itself.
    if (next > 0 && !this.stopping) this.agents.start();
    else this.agents.stop();
  }

  sendHeartbeat(force = false): void {
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
      ptys: this.sessions.summaries(),
    });
  }
}

export { PROTOCOL_VERSION };
