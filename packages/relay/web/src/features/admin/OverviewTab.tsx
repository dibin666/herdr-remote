import type { AdminStatusResponse } from '@protocol/http';
import type React from 'react';
import { useSettings } from '@/context/TerminalContext';
import { StatTile } from '@/shared/ui';
import { formatBytes, formatUptime } from './format';
import { HostsTable } from './HostsTable';

/** The board's first tab: the relay's figures, then who is on which workstation. */
export const OverviewTab: React.FC<{ data: AdminStatusResponse }> = ({ data }) => {
  const { t } = useSettings();
  /**
   * How many people are attached, not how many sockets are open.
   *
   * Several windows of one browser are one paired device and therefore one
   * user. A relay too old to report the figure only knows about connections,
   * which is the closest honest fallback.
   */
  const activeUserCount = data.activeUserCount ?? data.clients?.length ?? 0;

  /** Hosts the pairing roster remembers but the relay has no socket for. */
  const offlineHostCount = new Set(
    (data.devices || [])
      .map((device) => device.hostId)
      .filter((hostId) => hostId && !(data.hosts || []).some((host) => host.id === hostId)),
  ).size;

  return (
    <div className="space-y-3">
      {/*
       * A public relay's operator has two questions, and the board
       * answers them in that order: how much is attached and moving,
       * then who is attached to which workstation. Each figure is one
       * tile in its own colour, so the row reads at a glance; the
       * process readings that used to sit here — CPU, heap, event-loop
       * delay — describe whatever host runs the container, not the
       * service being operated, and stay off the board.
       */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={t('admin.connectedHosts')}
          value={data.hosts?.length || 0}
          sub={
            offlineHostCount ? t('admin.hostsOfflineSub', { count: offlineHostCount }) : undefined
          }
          tone={data.hosts?.length ? 'ok' : 'idle'}
        />
        <StatTile
          label={t('admin.activeUsers')}
          value={activeUserCount}
          sub={t('admin.acrossWindows', { count: data.clients?.length || 0 })}
          tone={activeUserCount ? 'accent' : 'idle'}
        />
        <StatTile
          label={t('admin.activePtys')}
          value={data.ptys?.length || 0}
          sub={t('admin.terminalShells')}
          tone={data.ptys?.length ? 'info' : 'idle'}
        />
        <StatTile
          label={t('admin.statInbound')}
          value={t('admin.perSecond', {
            value: formatBytes(data.throughput?.bytesInPerSec || 0),
          })}
          sub={t('admin.statTotal', { value: formatBytes(data.throughput?.bytesIn || 0) })}
          tone="accent"
        />
        <StatTile
          label={t('admin.statOutbound')}
          value={t('admin.perSecond', {
            value: formatBytes(data.throughput?.bytesOutPerSec || 0),
          })}
          sub={t('admin.statTotal', { value: formatBytes(data.throughput?.bytesOut || 0) })}
          tone="ok"
        />
        <StatTile
          label={t('admin.uptime')}
          value={formatUptime(data.uptimeSeconds || 0, t, true)}
          title={formatUptime(data.uptimeSeconds || 0, t)}
          sub={
            data.startTime
              ? t('admin.startedAt', {
                  time: new Date(data.startTime).toLocaleTimeString(),
                })
              : t('admin.startedRecently')
          }
        />
      </div>

      <HostsTable hosts={data.hosts || []} devices={data.devices} clients={data.clients || []} />
    </div>
  );
};
