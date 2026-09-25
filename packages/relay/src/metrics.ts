import os from 'node:os';
import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';
import type {
  AdminStatusResponse,
  CleanupCounters,
  ConnectedClientInfo,
  EventLoopDelayMetrics,
  HostInfo,
  PtyInfo,
  ThroughputMetrics,
} from './protocol/http.js';

/** Cleanup counters that `recordCleanup` may increment. */
export type CleanupCounterName = Exclude<keyof CleanupCounters, 'lastCleanupAt'>;

interface HostTrafficCounter {
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  sampleAt: number;
  sampleBytesIn: number;
  sampleBytesOut: number;
  sampleFramesIn: number;
  sampleFramesOut: number;
}

interface TrafficSample {
  at: number;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
}

/** A connection as `countActiveUsers` sees it. */
interface ClientIdentity {
  id: string;
  deviceId?: string | null;
}

export interface SnapshotOptions {
  clients?: ConnectedClientInfo[];
  hosts?: HostInfo[];
  ptys?: PtyInfo[];
  sample?: boolean;
  scopeHostId?: string | null;
  activeUserCount?: number | null;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function bytesPerSecond(current: number, previous: number, elapsedMs: number): number {
  if (!elapsedMs || elapsedMs <= 0) return 0;
  return Math.max(0, ((current - previous) * 1000) / elapsedMs);
}

/**
 * How many people are attached, rather than how many sockets are open.
 *
 * A phone and a laptop belonging to one person are two connections but one
 * paired device each, and one person opening three browser windows is three
 * connections and one device — so the distinct paired device is the closest
 * thing the relay has to a user. Connections that predate device pairing carry
 * no `deviceId`; they fall back to their own connection id so they still count
 * once instead of collapsing into a single anonymous user.
 */
function countActiveUsers(clients: readonly (ClientIdentity | null | undefined)[] = []): number {
  const identities = new Set<string>();
  for (const client of clients) {
    if (!client) continue;
    identities.add(
      typeof client.deviceId === 'string' && client.deviceId
        ? `device:${client.deviceId}`
        : `client:${client.id}`,
    );
  }
  return identities.size;
}

class RelayMetrics {
  readonly version: string;
  readonly protocolVersion: number;
  readonly startedAt: number;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  cleanup: Required<Omit<CleanupCounters, 'lastCleanupAt'>> & { lastCleanupAt: string | null };
  private lastSample: TrafficSample;
  private readonly hostTraffic: Map<string, HostTrafficCounter>;
  private cpuSampleAt: bigint;
  private cpuSample: NodeJS.CpuUsage;
  private readonly eventLoop: IntervalHistogram;

  constructor({ version = '0.1.0', protocolVersion = 1 } = {}) {
    this.version = version;
    this.protocolVersion = protocolVersion;
    this.startedAt = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.framesIn = 0;
    this.framesOut = 0;
    this.cleanup = {
      staleClientsPurged: 0,
      closedPtysCleaned: 0,
      deadConnectionsClosed: 0,
      idleHostsTerminated: 0,
      slowClientsDropped: 0,
      lastCleanupAt: null,
    };
    this.lastSample = { at: this.startedAt, bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0 };
    this.hostTraffic = new Map();
    this.cpuSampleAt = process.hrtime.bigint();
    this.cpuSample = process.cpuUsage();
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
  }

  hostCounter(hostId: string | null | undefined): HostTrafficCounter | null {
    if (typeof hostId !== 'string' || hostId.length === 0) return null;
    let counter = this.hostTraffic.get(hostId);
    if (!counter) {
      counter = {
        bytesIn: 0,
        bytesOut: 0,
        framesIn: 0,
        framesOut: 0,
        sampleAt: Date.now(),
        sampleBytesIn: 0,
        sampleBytesOut: 0,
        sampleFramesIn: 0,
        sampleFramesOut: 0,
      };
      this.hostTraffic.set(hostId, counter);
    }
    return counter;
  }

  recordIn(bytes: number, hostId: string | null = null): void {
    const amount = Math.max(0, Number(bytes) || 0);
    this.bytesIn += amount;
    this.framesIn += 1;
    const counter = this.hostCounter(hostId);
    if (counter) {
      counter.bytesIn += amount;
      counter.framesIn += 1;
    }
  }

  recordOut(bytes: number, hostId: string | null = null): void {
    const amount = Math.max(0, Number(bytes) || 0);
    this.bytesOut += amount;
    this.framesOut += 1;
    const counter = this.hostCounter(hostId);
    if (counter) {
      counter.bytesOut += amount;
      counter.framesOut += 1;
    }
  }

  forgetHost(hostId: string | null | undefined): void {
    if (typeof hostId === 'string') this.hostTraffic.delete(hostId);
  }

  hostThroughput(hostId: string | null | undefined, now = Date.now()): ThroughputMetrics {
    const counter = this.hostCounter(hostId);
    if (!counter)
      return {
        bytesIn: 0,
        bytesOut: 0,
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
        framesIn: 0,
        framesOut: 0,
        framesInPerSec: 0,
        framesOutPerSec: 0,
      };
    const elapsedMs = now - counter.sampleAt;
    const throughput: ThroughputMetrics = {
      bytesIn: counter.bytesIn,
      bytesOut: counter.bytesOut,
      bytesInPerSec: bytesPerSecond(counter.bytesIn, counter.sampleBytesIn, elapsedMs),
      bytesOutPerSec: bytesPerSecond(counter.bytesOut, counter.sampleBytesOut, elapsedMs),
      framesIn: counter.framesIn,
      framesOut: counter.framesOut,
      framesInPerSec: bytesPerSecond(counter.framesIn, counter.sampleFramesIn, elapsedMs),
      framesOutPerSec: bytesPerSecond(counter.framesOut, counter.sampleFramesOut, elapsedMs),
    };
    counter.sampleAt = now;
    counter.sampleBytesIn = counter.bytesIn;
    counter.sampleBytesOut = counter.bytesOut;
    counter.sampleFramesIn = counter.framesIn;
    counter.sampleFramesOut = counter.framesOut;
    return throughput;
  }

  recordCleanup(name: CleanupCounterName, amount = 1): void {
    if (Object.hasOwn(this.cleanup, name) && typeof this.cleanup[name] === 'number') {
      this.cleanup[name] += amount;
    }
    this.cleanup.lastCleanupAt = new Date().toISOString();
  }

  cpuPercent(): number {
    const now = process.hrtime.bigint();
    const elapsedNs = Number(now - this.cpuSampleAt);
    const usage = process.cpuUsage(this.cpuSample);
    this.cpuSampleAt = now;
    this.cpuSample = process.cpuUsage();
    if (elapsedNs <= 0) return 0;
    const percent = ((usage.user + usage.system) * 100000) / elapsedNs;
    return Math.max(0, Math.round(percent * 100) / 100);
  }

  eventLoopDelay(): EventLoopDelayMetrics {
    const percentile = (value: number) => Math.round(finite(value / 1e6) * 100) / 100;
    return {
      p50Ms: percentile(this.eventLoop.percentile(50)),
      p90Ms: percentile(this.eventLoop.percentile(90)),
      p99Ms: percentile(this.eventLoop.percentile(99)),
      maxMs: percentile(this.eventLoop.max),
      meanMs: percentile(this.eventLoop.mean),
    };
  }

  /**
   * `activeUserCount` is passed in rather than derived from `clients`: the
   * public `/api/status` rows deliberately omit `deviceId`, so only the caller
   * still holding the full connection records can count devices correctly.
   * Omitting it falls back to counting whatever the given rows identify.
   */
  snapshot({
    clients = [],
    hosts = [],
    ptys = [],
    sample = true,
    scopeHostId = null,
    activeUserCount = null,
  }: SnapshotOptions = {}): AdminStatusResponse {
    const now = Date.now();
    const elapsedMs = now - this.lastSample.at;
    const throughput: ThroughputMetrics = {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      bytesInPerSec: bytesPerSecond(this.bytesIn, this.lastSample.bytesIn, elapsedMs),
      bytesOutPerSec: bytesPerSecond(this.bytesOut, this.lastSample.bytesOut, elapsedMs),
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      framesInPerSec: bytesPerSecond(this.framesIn, this.lastSample.framesIn, elapsedMs),
      framesOutPerSec: bytesPerSecond(this.framesOut, this.lastSample.framesOut, elapsedMs),
    };
    if (sample) {
      this.lastSample = {
        at: now,
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
        framesIn: this.framesIn,
        framesOut: this.framesOut,
      };
    }
    const memory = process.memoryUsage();
    const load = os.loadavg();
    // Every attached window has full input, so there is no "active controller"
    // to name: reporting the first of them as one had an operator reading a
    // distinction that does not exist. The host is still worth naming, and any
    // client knows which workstation it is on.
    const anyClient = clients[0];
    const scopedThroughput = scopeHostId ? this.hostThroughput(scopeHostId, now) : throughput;
    return {
      version: this.version,
      protocolVersion: this.protocolVersion,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      startTime: new Date(this.startedAt).toISOString(),
      serverTime: new Date(now).toISOString(),
      activeControllerId: null,
      activeHostId: anyClient?.hostId || hosts[0]?.id || null,
      clients,
      hosts,
      ptys,
      clientCount: clients.length,
      hostCount: hosts.length,
      ptyCount: ptys.length,
      activeUserCount: Number.isFinite(activeUserCount)
        ? (activeUserCount as number)
        : countActiveUsers(clients),
      throughput: scopedThroughput,
      cpu: {
        load1m: finite(load[0]),
        load5m: finite(load[1]),
        load15m: finite(load[2]),
        cpuPercent: this.cpuPercent(),
        cores: os.cpus().length,
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        systemTotalBytes: os.totalmem(),
        systemFreeBytes: os.freemem(),
      },
      eventLoopDelay: this.eventLoopDelay(),
      cleanup: { ...this.cleanup },
    };
  }

  close(): void {
    this.eventLoop.disable();
    this.hostTraffic.clear();
  }
}

export { RelayMetrics, countActiveUsers };
