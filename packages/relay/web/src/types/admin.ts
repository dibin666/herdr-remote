/**
 * Herdr Remote Admin Status Types
 * Corresponds to GET /api/status, GET /api/admin/status, and GET /api/info
 */

export interface RelayInfoResponse {
  ok: boolean;
  version: string;
  protocol: number;
  relayMode: 'local' | 'remote';
  adminConfigured: boolean;
  adminPath: string;
  adminStatusPath: string;
  publicUrl?: string;
}

export interface RelayMetadata {
  mode: 'local' | 'remote';
  adminConfigured: boolean;
  adminPath?: string;
  adminStatusPath?: string;
  publicUrl?: string;
}

export interface ConnectedClientInfo {
  id: string;
  role: 'controller' | 'viewer';
  ip?: string;
  userAgent?: string;
  connectedAt: string;
  lastPingAt?: string;
  bytesReceived?: number;
  bytesSent?: number;
}

/**
 * A device that completed pairing and holds a long-lived token. Served only on
 * `/api/admin/status`, never on `/api/status`.
 */
export interface PairedDeviceInfo {
  deviceId: string;
  hostId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: number;
  expiresAtIso: string;
  userAgent?: string | null;
  lastIp?: string | null;
}

export interface HostInfo {
  id: string;
  hostname: string;
  platform: string;
  arch?: string;
  status: 'online' | 'busy' | 'offline';
  connectedAt: string;
  activePtyCount: number;
}

export interface PtyInfo {
  id: string;
  pid: number;
  command: string;
  cols: number;
  rows: number;
  cwd?: string;
  createdAt: string;
  activeClients: number;
}

export interface ThroughputMetrics {
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesIn: number;
  framesOut: number;
  framesInPerSec: number;
  framesOutPerSec: number;
}

export interface CpuLoadMetrics {
  load1m: number;
  load5m: number;
  load15m: number;
  cpuPercent: number;
  cores: number;
}

export interface MemoryMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes?: number;
  systemTotalBytes?: number;
  systemFreeBytes?: number;
}

export interface EventLoopDelayMetrics {
  p50Ms: number;
  p90Ms?: number;
  p99Ms: number;
  maxMs: number;
  meanMs?: number;
}

export interface CleanupCounters {
  staleClientsPurged: number;
  closedPtysCleaned: number;
  deadConnectionsClosed: number;
  idleHostsTerminated: number;
  lastCleanupAt?: string;
}

export interface AdminStatusResponse {
  version: string;
  uptimeSeconds: number;
  startTime: string;
  serverTime: string;
  activeControllerId?: string | null;
  activeHostId?: string | null;
  clients: ConnectedClientInfo[];
  hosts: HostInfo[];
  ptys: PtyInfo[];
  /** Operator-only roster of paired devices; absent from `/api/status`. */
  devices?: PairedDeviceInfo[];
  throughput: ThroughputMetrics;
  cpu: CpuLoadMetrics;
  memory: MemoryMetrics;
  eventLoopDelay: EventLoopDelayMetrics;
  cleanup: CleanupCounters;
  protocolVersion: number;
  relay?: RelayMetadata;
  isRemoteRelay?: boolean;
  remoteAdminUrl?: string;
  relayMode?: 'local' | 'remote';
  [key: string]: unknown;
}
