// What `/api/status` and `/api/admin/status` report: the relay's metrics plus
// the hosts, windows and PTYs it can see, scoped to one tenant when asked.

import { countActiveUsers } from '../metrics.js';
import type { AdminStatusResponse, HostInfo, PtyInfo } from '../protocol/http.js';
import type { RelayClient, RelayContext } from './types.js';

export interface StatusOptions {
  /** Advance the throughput sample; off for reads that must not skew the rates. */
  sample?: boolean;
  /** Include the paired-device roster, which only the relay operator may see. */
  includeDevices?: boolean;
  /** Report only this workstation and its windows. */
  scopeHostId?: string | null;
}

export function statusSnapshot(
  relay: RelayContext,
  { sample = true, includeDevices = false, scopeHostId = null }: StatusOptions = {},
): AdminStatusResponse {
  const scopedClients = scopeHostId
    ? [...relay.clients.values()].filter((client) => client.hostId === scopeHostId)
    : [...relay.clients.values()];
  const scopedHosts = scopeHostId
    ? [...relay.hosts.values()].filter((host) => host.id === scopeHostId)
    : [...relay.hosts.values()];
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
  const pairedDevices = relay.auth.listDevices();
  const pairedPerHost = new Map<string, number>();
  for (const device of pairedDevices) {
    pairedPerHost.set(device.hostId, (pairedPerHost.get(device.hostId) || 0) + 1);
  }
  const hosts: HostInfo[] = scopedHosts.map((host) => ({
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
      [...host.clients]
        .map((id) => relay.clients.get(id))
        .filter((client): client is RelayClient => Boolean(client)),
    ),
    pairedDeviceCount: pairedPerHost.get(host.id) || 0,
    load: host.load,
  }));
  // The workstation counts one PTY per stream and cannot know how many
  // windows are watching it; the relay does, and that is the number an
  // operator needs when the session is shared. Scoped callers only receive
  // the PTYs belonging to their authenticated host.
  const ptys: PtyInfo[] = scopedHosts.flatMap((host) =>
    host.ptys.map((pty) => ({
      ...pty,
      ...(scopeHostId ? {} : { hostId: host.id }),
      activeClients: host.clients.size,
    })),
  );
  // The paired-device roster identifies people's hardware, so it is served to
  // the relay operator only — never on /api/status, which any paired device
  // may read.
  const devices = includeDevices ? pairedDevices : undefined;
  const address = relay.address();
  return {
    ...relay.metrics.snapshot({
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
    relayMode: relay.relayMode,
    isRemoteRelay: relay.relayMode === 'remote',
    remoteAdminUrl:
      relay.relayMode === 'remote'
        ? `${String(relay.config.relay.publicUrl || '').replace(/\/+$/, '')}/admin`
        : undefined,
    relay: {
      mode: relay.relayMode,
      publicUrl: relay.config.relay.publicUrl,
      bind: relay.config.relay.host,
      port: (address && 'port' in address ? address.port : undefined) || relay.config.relay.port,
      maxClientsPerHost: relay.config.relay.maxClientsPerHost,
      maxHosts: relay.config.relay.maxHosts,
      maxPendingHandshakes: relay.config.relay.maxPendingHandshakes,
      maxBufferedBytesPerClient: relay.config.relay.maxBufferedBytesPerClient,
      hostReconnectGraceMs: relay.config.relay.hostReconnectGraceMs,
      adminConfigured: Boolean(relay.adminToken),
      adminStatusPath: '/api/admin/status',
      dashboardPath: '/admin',
    },
  };
}
