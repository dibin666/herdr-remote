// The relay's records for connected hosts and browser windows, and the state
// every server module works on.

import type { WebSocket } from 'ws';
import type { AuthStore } from '../auth-store.js';
import type { RelayMetrics } from '../metrics.js';
import type {
  ClientRole,
  HostPtySummary,
  ServerAgentStatusMessage,
  ServerUpdateStatusMessage,
} from '../protocol/messages.js';
import type { HostTerminalFont, HostTerminalPalette } from '../protocol/terminal.js';
import type { RelayConfig } from '../relay-config.js';

/** A WebSocket plus the liveness flag the heartbeat keeps on it. */
export type RelaySocket = WebSocket & { isAlive?: boolean };

/** One browser window's PTY stream on its host. */
export interface ClientSession {
  streamId: string;
  /** The v2 frame index, when the host negotiated v2 frames and one was free. */
  streamIndex: number | null;
  cols: number;
  rows: number;
  ready: boolean;
}

/** A connected workstation. */
export interface RelayHost {
  id: string;
  ws: RelaySocket | null;
  hostname: string;
  platform: string;
  arch: string;
  connectedAt: string;
  connectedAtMs: number;
  terminalPalette: HostTerminalPalette | null;
  terminalFont: HostTerminalFont | null;
  /** The latest agent summary, replayed to a window that joins late. */
  agentStatus: ServerAgentStatusMessage | null;
  /** Whether the workstation's herdr-remote is behind; replayed the same way. */
  updateStatus: ServerUpdateStatusMessage | null;
  lastSeenAt: number;
  /** Ids of the windows attached to this host. */
  clients: Set<string>;
  controllerId: null;
  load: Record<string, unknown>;
  ptys: HostPtySummary[];
  reconnecting: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectStartedAt?: number;
  connectionGeneration: string;
  handoffCapable: boolean;
  binaryFrameV2: boolean;
  /** v2 stream index → client id. */
  streamIndices: Map<number, string>;
  nextStreamIndex: number;
  shutdownRequested: boolean;
}

/** A connected browser window. */
export interface RelayClient {
  id: string;
  ws: RelaySocket | null;
  hostId: string;
  deviceId: string;
  /** Stable per browser profile, supplied by the browser itself. */
  browserClientId: string | null;
  handoffCapable: boolean;
  session: ClientSession | null;
  role: ClientRole;
  controllerId: null;
  connectedAt: string;
  connectedAtMs: number;
  lastSeenAt: number;
  lastPingAt: string | null;
  bytesReceived: number;
  bytesSent: number;
  ip: string | null;
  userAgent: string;
  cols: number;
  rows: number;
  herdrStartAt?: number;
  fontRefreshAt?: number;
  /** When each outstanding font chunk request was sent. */
  fontChunkRequests?: number[];
  fontSubsetRequests?: number[];
  /** Cut fonts this window may pull by hash, with their sizes. */
  fontSubsets?: Map<string, number>;
}

/** Requests from one address within the current minute. */
export interface AttemptWindow {
  startedAt: number;
  count: number;
}

/** Frames held back by the development latency switch, in order. */
export interface SendQueue {
  items: { sendAt: number; task: () => void }[];
  timer: NodeJS.Timeout | null;
}

/** What the server modules share: the relay's state and two of its methods. */
export interface RelayContext {
  config: RelayConfig;
  relayMode: 'local' | 'remote';
  hosts: Map<string, RelayHost>;
  clients: Map<string, RelayClient>;
  /** Stream id → client id. */
  streams: Map<string, string>;
  pairAttempts: Map<string, AttemptWindow>;
  clientHandshakeAttempts: Map<string, AttemptWindow>;
  hostHandshakeAttempts: Map<string, AttemptWindow>;
  startedAt: number;
  metrics: RelayMetrics;
  auth: AuthStore;
  adminToken: string | null;
  trustProxy: boolean;
  devLatencyMs: number;
  devDelayMs: number;
  sendQueues: WeakMap<RelaySocket, SendQueue>;
  activeDelayTimers: Set<NodeJS.Timeout>;
  finishHandshake(ws: RelaySocket): void;
  address(): { host: string; port: number } | { path: string } | null;
}
