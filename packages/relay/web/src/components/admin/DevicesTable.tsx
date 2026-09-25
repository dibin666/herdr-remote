import type React from 'react';
import { useState } from 'react';
import type { ConnectedClientInfo, PairedDeviceInfo } from '@protocol/http';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';
import { cn } from '../../utils/cn';
import { Button, type Column, Panel, Spinner, StatusDot, Table } from '../tui';
import { formatRelative, formatTimestamp, windowsByDevice } from './format';

interface DevicesTableProps {
  devices: PairedDeviceInfo[];
  /** Live connections, to mark which devices are attached right now. */
  clients?: ConnectedClientInfo[];
  /** Resolves once the relay has revoked the device and dropped its sockets. */
  onRevoke: (deviceId: string) => Promise<void>;
}

/**
 * Every device holding a long-lived token, and the way to take one back.
 *
 * Online devices come first: those are the ones a revocation would cut off
 * mid-session, and the ones an operator is usually looking for.
 */
export const DevicesTable: React.FC<DevicesTableProps> = ({ devices, clients, onRevoke }) => {
  const { t } = useTerminal();
  // Which device the operator has clicked once. Revoking cuts off a real person
  // mid-session, so it takes a second, deliberate click rather than a single
  // stray tap on a phone-sized dashboard.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const windows = windowsByDevice(clients);
  const sorted = [...devices].sort((a, b) => {
    const online =
      Number(Boolean(windows.get(b.deviceId))) - Number(Boolean(windows.get(a.deviceId)));
    if (online) return online;
    return (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
  });

  const handleRevoke = async (deviceId: string) => {
    if (pendingId !== deviceId) {
      setPendingId(deviceId);
      return;
    }
    setBusyId(deviceId);
    try {
      await onRevoke(deviceId);
    } finally {
      setBusyId(null);
      setPendingId(null);
    }
  };

  const columns: Column<PairedDeviceInfo>[] = [
    {
      key: 'status',
      header: t('admin.colStatus'),
      width: 12,
      render: (device) => {
        const open = windows.get(device.deviceId) || 0;
        return (
          <span
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap',
              open ? 'text-tui-ok' : 'text-tui-faint',
            )}
          >
            <StatusDot level={open ? 'ok' : 'idle'} />
            {open ? t('admin.hostStatusOnline') : t('admin.hostStatusOffline')}
          </span>
        );
      },
    },
    {
      key: 'device',
      header: t('admin.colDevice'),
      render: (device) => {
        const described = describeUserAgent(device.userAgent);
        return (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-tui-text" title={described.raw}>
              {described.label || t('admin.unknownDevice')}
            </span>
            <code className="text-tui-sm text-tui-faint">{device.deviceId}</code>
          </span>
        );
      },
    },
    {
      key: 'host',
      header: t('admin.colHost'),
      render: (device) => <span className="text-tui-text">{device.hostId || '—'}</span>,
    },
    {
      key: 'ip',
      header: t('admin.colIp'),
      render: (device) => <span className="text-tui-muted">{device.lastIp || '—'}</span>,
    },
    {
      key: 'lastSeen',
      header: t('admin.colLastSeen'),
      render: (device) => {
        const open = windows.get(device.deviceId) || 0;
        return (
          <span
            className={cn('whitespace-nowrap', open ? 'text-tui-ok' : 'text-tui-muted')}
            title={formatTimestamp(device.lastSeenAt)}
          >
            {open
              ? t('admin.deviceWindows', { count: open })
              : formatRelative(device.lastSeenAt, t)}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('admin.colActions'),
      align: 'right',
      render: (device) => {
        const isPending = pendingId === device.deviceId;
        const isBusy = busyId === device.deviceId;
        return (
          <Button
            variant="danger"
            disabled={isBusy}
            onClick={() => void handleRevoke(device.deviceId)}
            onBlur={() => setPendingId((current) => (current === device.deviceId ? null : current))}
            aria-label={t('admin.revokeDevice')}
            className={cn('h-6 py-0 text-tui-sm', isPending && 'bg-tui-bad text-tui-crust')}
          >
            {isBusy ? <Spinner /> : isPending ? t('admin.revokeConfirm') : t('admin.revokeDevice')}
          </Button>
        );
      },
    },
  ];

  return (
    <Panel title={t('admin.pairedDevicesTitle', { count: devices.length })} bodyClassName="-mx-1">
      <Table
        columns={columns}
        items={sorted}
        rowKey={(device) => device.deviceId}
        empty={t('admin.noDevices')}
      />
    </Panel>
  );
};
