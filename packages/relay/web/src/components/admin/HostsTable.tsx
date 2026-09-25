import React from 'react';
import { ConnectedClientInfo, HostInfo, HostStatus, PairedDeviceInfo } from '../../types/admin';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';
import { cn } from '../../utils/cn';
import { Badge, Panel, Segments, StatusDot } from '../tui';
import { formatRelative, formatTimestamp, windowsByDevice } from './format';

interface HostsTableProps {
  hosts: HostInfo[];
  /** Operator-only roster. Absent on `/api/status`, where counts are all there is. */
  devices?: PairedDeviceInfo[];
  /** Live connections, to tell which paired devices are attached right now. */
  clients?: ConnectedClientInfo[];
}

/** A host as the board draws it: what the relay knows plus who is paired to it. */
interface HostRow {
  id: string;
  hostname: string;
  status: HostStatus;
  connectedDeviceCount: number;
  pairedDeviceCount: number;
  activePtyCount: number;
  devices: PairedDeviceInfo[];
  /** True when nothing but the pairing roster remembers this host. */
  fromRosterOnly: boolean;
}

const STATUS_TONE: Record<HostStatus, 'ok' | 'warn' | 'idle'> = {
  online: 'ok',
  busy: 'ok',
  reconnecting: 'warn',
  offline: 'idle',
};

/**
 * Merge the live host list with the pairing roster, keyed by host id.
 *
 * A public relay's operator needs both halves of the picture, and neither list
 * holds it alone: `hosts` is only what is connected right now, and `devices` is
 * only what has paired. A workstation that has gone away still has people
 * paired to it, and dropping it from the board would read as "those devices
 * belong to nothing" — so it stays, marked offline.
 */
export function buildHostRows(
  hosts: HostInfo[] = [],
  devices: PairedDeviceInfo[] = []
): HostRow[] {
  const devicesByHost = new Map<string, PairedDeviceInfo[]>();
  for (const device of devices) {
    if (!device?.hostId) continue;
    const bucket = devicesByHost.get(device.hostId);
    if (bucket) bucket.push(device);
    else devicesByHost.set(device.hostId, [device]);
  }

  const rows: HostRow[] = hosts.map((host) => {
    const paired = devicesByHost.get(host.id) || [];
    return {
      id: host.id,
      hostname: host.hostname || host.id,
      status: host.status || 'online',
      connectedDeviceCount: host.connectedDeviceCount ?? 0,
      // The relay's own tally wins: it counts every valid pairing, while the
      // roster is only present for an operator.
      pairedDeviceCount: host.pairedDeviceCount ?? paired.length,
      activePtyCount: host.activePtyCount ?? 0,
      devices: paired,
      fromRosterOnly: false,
    };
  });

  const listed = new Set(rows.map((row) => row.id));
  for (const [hostId, paired] of devicesByHost) {
    if (listed.has(hostId)) continue;
    rows.push({
      id: hostId,
      hostname: hostId,
      status: 'offline',
      connectedDeviceCount: 0,
      pairedDeviceCount: paired.length,
      activePtyCount: 0,
      devices: paired,
      fromRosterOnly: true,
    });
  }

  // Connected first, then the merely-remembered, each half alphabetical so a
  // row does not move around under the operator between polls.
  return rows.sort((a, b) => {
    if (a.fromRosterOnly !== b.fromRosterOnly) return a.fromRosterOnly ? 1 : -1;
    return a.hostname.localeCompare(b.hostname);
  });
}

/**
 * Which workstations this relay is carrying, and who is paired to each.
 *
 * On a public relay this is the board's main question — a count of clients says
 * nothing about *whose* machines they are attached to — so each host is its own
 * block: name and status on its first line with the counts beside them, then
 * each paired device on a line of its own, lit when it is attached right now
 * and otherwise saying how long ago it was last seen.
 */
export const HostsTable: React.FC<HostsTableProps> = ({ hosts, devices, clients }) => {
  const { t } = useTerminal();
  const rows = buildHostRows(hosts, devices);
  const windows = windowsByDevice(clients);
  const statusLabel: Record<HostStatus, string> = {
    online: t('admin.hostStatusOnline'),
    busy: t('admin.hostStatusBusy'),
    reconnecting: t('admin.hostStatusReconnecting'),
    offline: t('admin.hostStatusOffline'),
  };

  return (
    <Panel title={t('admin.hostsTitle', { count: rows.length })} bodyClassName="space-y-2">
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-tui text-tui-faint">{t('admin.noHosts')}</p>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="border border-tui-border-dim bg-tui-mantle">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-tui-border-dim px-2 py-1">
              {/* Sized to its content, so on a narrow screen the counts drop to
                  their own line instead of cutting the host's name short. */}
              <span className="flex min-w-0 flex-auto items-center gap-1.5 text-tui">
                <StatusDot level={STATUS_TONE[row.status]} />
                <span className="truncate font-bold text-tui-text">{row.hostname}</span>
                {row.hostname !== row.id ? (
                  <code className="truncate text-tui-sm text-tui-faint">{row.id}</code>
                ) : null}
                <Badge tone={STATUS_TONE[row.status]} className="ml-1 text-tui-sm">
                  {statusLabel[row.status]}
                </Badge>
              </span>
              <Segments
                className="shrink-0 text-tui-sm"
                items={[
                  <span key="connected" className={row.connectedDeviceCount ? 'text-tui-ok' : 'text-tui-faint'}>
                    {t('admin.hostConnectedDevices', { count: row.connectedDeviceCount })}
                  </span>,
                  <span key="paired" className="text-tui-muted">
                    {t('admin.hostPairedDevices', { count: row.pairedDeviceCount })}
                  </span>,
                  row.fromRosterOnly ? null : (
                    <span key="ptys" className={row.activePtyCount ? 'text-tui-info' : 'text-tui-faint'}>
                      {t('admin.hostPtys', { count: row.activePtyCount })}
                    </span>
                  ),
                ]}
              />
            </div>

            {row.devices.length > 0 ? (
              <ul className="divide-y divide-tui-border-dim">
                {row.devices.map((device) => {
                  const described = describeUserAgent(device.userAgent);
                  const open = windows.get(device.deviceId) || 0;
                  return (
                    <li
                      key={device.deviceId}
                      className="grid grid-cols-[1ch_minmax(0,1fr)_auto] items-baseline gap-x-2 px-2 py-0.5 text-tui sm:grid-cols-[1ch_minmax(0,18ch)_minmax(0,1fr)_16ch_12ch]"
                    >
                      <StatusDot level={open ? 'ok' : 'idle'} />
                      <span className="truncate text-tui-text" title={described.raw}>
                        {described.label || t('admin.unknownDevice')}
                      </span>
                      <code className="hidden truncate text-tui-sm text-tui-faint sm:block">{device.deviceId}</code>
                      <span className="hidden truncate text-tui-sm text-tui-muted sm:block">
                        {device.lastIp || '—'}
                      </span>
                      <span
                        className={cn('truncate text-right text-tui-sm', open ? 'text-tui-ok' : 'text-tui-faint')}
                        title={formatTimestamp(device.lastSeenAt)}
                      >
                        {open
                          ? t('admin.deviceWindows', { count: open })
                          : formatRelative(device.lastSeenAt, t)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              /* Without the operator token the counts arrive but the roster does
                 not, so say which of the two situations this is. */
              <p className="px-2 py-1 text-tui-sm text-tui-faint">
                {row.pairedDeviceCount > 0
                  ? t('admin.hostRosterOperatorOnly')
                  : t('admin.noDevices')}
              </p>
            )}
          </div>
        ))
      )}
    </Panel>
  );
};
