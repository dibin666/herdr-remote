'use strict';

const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function bytesPerSecond(current, previous, elapsedMs) {
  if (!elapsedMs || elapsedMs <= 0) return 0;
  return Math.max(0, (current - previous) * 1000 / elapsedMs);
}

class RelayMetrics {
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
      lastCleanupAt: null,
    };
    this.lastSample = { at: this.startedAt, bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0 };
    this.cpuSampleAt = process.hrtime.bigint();
    this.cpuSample = process.cpuUsage();
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
  }

  recordIn(bytes) {
    this.bytesIn += bytes;
    this.framesIn += 1;
  }

  recordOut(bytes) {
    this.bytesOut += bytes;
    this.framesOut += 1;
  }

  recordCleanup(name, amount = 1) {
    if (Object.prototype.hasOwnProperty.call(this.cleanup, name) && typeof this.cleanup[name] === 'number') {
      this.cleanup[name] += amount;
    }
    this.cleanup.lastCleanupAt = new Date().toISOString();
  }

  cpuPercent() {
    const now = process.hrtime.bigint();
    const elapsedNs = Number(now - this.cpuSampleAt);
    const usage = process.cpuUsage(this.cpuSample);
    this.cpuSampleAt = now;
    this.cpuSample = process.cpuUsage();
    if (elapsedNs <= 0) return 0;
    const percent = ((usage.user + usage.system) * 100000) / elapsedNs;
    return Math.max(0, Math.round(percent * 100) / 100);
  }

  eventLoopDelay() {
    const percentile = (value) => Math.round(finite(value / 1e6) * 100) / 100;
    return {
      p50Ms: percentile(this.eventLoop.percentile(50)),
      p90Ms: percentile(this.eventLoop.percentile(90)),
      p99Ms: percentile(this.eventLoop.percentile(99)),
      maxMs: percentile(this.eventLoop.max),
      meanMs: percentile(this.eventLoop.mean),
    };
  }

  snapshot({ clients = [], hosts = [], ptys = [], sample = true } = {}) {
    const now = Date.now();
    const elapsedMs = now - this.lastSample.at;
    const throughput = {
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
      this.lastSample = { at: now, bytesIn: this.bytesIn, bytesOut: this.bytesOut, framesIn: this.framesIn, framesOut: this.framesOut };
    }
    const memory = process.memoryUsage();
    const load = os.loadavg();
    // Every attached window has full input, so there is no "active controller"
    // to name: reporting the first of them as one had an operator reading a
    // distinction that does not exist. The host is still worth naming, and any
    // client knows which workstation it is on.
    const anyClient = clients[0];
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
      throughput,
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

  close() {
    this.eventLoop.disable();
  }
}

module.exports = { RelayMetrics };
