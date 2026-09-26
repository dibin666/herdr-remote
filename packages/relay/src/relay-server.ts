// The relay: one HTTP server that answers the API, serves the web app and
// upgrades /ws/host and /ws/client. The work itself lives in ./server/.

import http from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { AuthStore } from './auth-store.js';
import { RelayMetrics } from './metrics.js';
import { PROTOCOL_VERSION, WS_CLIENT_PATH, WS_HOST_PATH } from './protocol/index.js';
import { DEFAULTS, defaultStateDir, loadRelayConfig, type RelayConfig } from './relay-config.js';
import { handleClientConnection } from './server/client-channel.js';
import { handleHostConnection } from './server/host-channel.js';
import { handleHttp } from './server/http-api.js';
import { heartbeat, sweep } from './server/maintenance.js';
import { isAllowedOrigin } from './server/requests.js';
import { detachClient, detachHost } from './server/sessions.js';
import type {
  AttemptWindow,
  RelayClient,
  RelayContext,
  RelayHost,
  RelaySocket,
  SendQueue,
} from './server/types.js';
import { VERSION } from './server/version.js';
import { ensureDir } from './state.js';

/** A configuration with any field left out; the defaults fill the rest. */
export type RelayConfigInput = { [Section in keyof RelayConfig]?: Partial<RelayConfig[Section]> };

/** Overrides for embedding the relay, mostly in tests. */
export interface RelayServerOptions {
  stateFile?: string;
  password?: string | null;
  adminToken?: string | null;
  trustProxy?: boolean;
  /** Simulated round-trip latency; each direction is delayed by half. */
  devLatencyMs?: number | string;
  metrics?: RelayMetrics;
  auth?: AuthStore;
}

export type RelayAddress = { host: string; port: number } | { path: string };

class RelayServer implements RelayContext {
  config: RelayConfig;
  relayMode: 'local' | 'remote';
  hosts = new Map<string, RelayHost>();
  clients = new Map<string, RelayClient>();
  streams = new Map<string, string>();
  pairAttempts = new Map<string, AttemptWindow>();
  clientHandshakeAttempts = new Map<string, AttemptWindow>();
  hostHandshakeAttempts = new Map<string, AttemptWindow>();
  /** Sockets that are upgraded but have not finished their hello. */
  pendingHandshakes = new Set<RelaySocket>();
  startedAt = Date.now();
  metrics: RelayMetrics;
  stateFile: string;
  password: string | null;
  adminToken: string | null;
  trustProxy: boolean;
  devLatencyMs: number;
  devDelayMs: number;
  sendQueues = new WeakMap<RelaySocket, SendQueue>();
  activeDelayTimers = new Set<NodeJS.Timeout>();
  auth: AuthStore;
  server: http.Server;
  wss: WebSocketServer;
  heartbeatTimer: NodeJS.Timeout | null = null;
  cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    config: RelayConfigInput = loadRelayConfig().config,
    options: RelayServerOptions = {},
  ) {
    this.config = {
      relay: { ...DEFAULTS.relay, ...config.relay },
      auth: { ...DEFAULTS.auth, ...config.auth },
      cleanup: { ...DEFAULTS.cleanup, ...config.cleanup },
    };
    const { relay, auth } = this.config;
    this.relayMode = relay.mode === 'local' ? 'local' : 'remote';
    this.metrics =
      options.metrics || new RelayMetrics({ version: VERSION, protocolVersion: PROTOCOL_VERSION });
    this.stateFile =
      options.stateFile || auth.stateFile || path.join(defaultStateDir(), 'relay-auth.json');
    this.password = options.password ?? auth.password ?? null;
    this.adminToken = options.adminToken ?? auth.adminToken ?? null;
    this.trustProxy = Boolean(options.trustProxy ?? relay.trustProxy);
    // Development-only artificial latency switch for local responsiveness profiling.
    // When unset or 0, this incurs zero overhead and avoids entering the delayed path.
    // RELAY_DEV_LATENCY_MS specifies round-trip delay, so each one-way leg
    // (host -> browser and browser -> host) is delayed by half.
    const devLatencyRaw =
      options.devLatencyMs ?? relay.devLatencyMs ?? process.env.RELAY_DEV_LATENCY_MS;
    this.devLatencyMs = devLatencyRaw
      ? Math.max(0, Number.parseInt(String(devLatencyRaw), 10) || 0)
      : 0;
    this.devDelayMs = this.devLatencyMs > 0 ? Math.round(this.devLatencyMs / 2) : 0;
    this.auth =
      options.auth ||
      new AuthStore({
        stateFile: this.stateFile,
        pairingTtlMs: auth.pairingTtlMs,
        deviceTtlMs: auth.deviceTtlMs,
        maxDevices: auth.maxDevices,
        password: this.password,
      });
    this.server = http.createServer((req, res) => handleHttp(this, req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: relay.maxPayloadBytes,
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
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  listen(port = this.config.relay.port, host = this.config.relay.host): Promise<RelayAddress> {
    ensureDir(path.dirname(this.stateFile));
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.heartbeatTimer = setInterval(
          () => heartbeat(this),
          this.config.cleanup.heartbeatIntervalMs,
        );
        this.cleanupTimer = setInterval(() => sweep(this), this.config.cleanup.intervalMs);
        resolve(this.address() as RelayAddress);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
  }

  address(): RelayAddress | null {
    const address = this.server.address();
    if (!address) return null;
    return typeof address === 'string'
      ? { path: address }
      : { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
    for (const timer of this.activeDelayTimers) clearTimeout(timer);
    this.activeDelayTimers.clear();
    for (const client of [...this.clients.values()]) detachClient(this, client, { notify: false });
    for (const host of [...this.hosts.values()]) detachHost(this, host, { notify: false });
    this.streams.clear();
    this.pairAttempts.clear();
    this.clientHandshakeAttempts.clear();
    this.hostHandshakeAttempts.clear();
    this.pendingHandshakes.clear();
    this.metrics.close();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (() => {
      try {
        return new URL(req.url || '', 'http://localhost').pathname;
      } catch {
        return '';
      }
    })();
    if (
      ![WS_HOST_PATH, WS_CLIENT_PATH].includes(pathname) ||
      !isAllowedOrigin(this, req.headers.origin, req)
    ) {
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
      const tcp = socket as Duplex & {
        setNoDelay(noDelay: boolean): void;
        setKeepAlive?(enable: boolean, initialDelay: number): void;
      };
      tcp.setNoDelay(true);
      tcp.setKeepAlive?.(true, this.config.cleanup.heartbeatIntervalMs);
    } catch {
      // Not a TCP socket (tests, proxies); these are only latency and liveness tweaks.
    }
    this.wss.handleUpgrade(req, socket, head, (ws: RelaySocket) => {
      this.pendingHandshakes.add(ws);
      ws.once('close', () => this.finishHandshake(ws));
      if (pathname === WS_HOST_PATH) handleHostConnection(this, ws, req);
      else handleClientConnection(this, ws, req);
    });
  }

  finishHandshake(ws: RelaySocket): void {
    this.pendingHandshakes.delete(ws);
  }
}

export { RelayServer, PROTOCOL_VERSION, VERSION };
