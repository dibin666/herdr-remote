import React, { useState } from 'react';
import { PairedDeviceInfo } from '../../types/admin';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';
import { Button, Column, Panel, Spinner, Table } from '../tui';

interface DevicesTableProps {
  devices: PairedDeviceInfo[];
  /** Resolves once the relay has revoked the device and dropped its sockets. */
  onRevoke: (deviceId: string) => Promise<void>;
}

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

/** Every device holding a long-lived token, and the way to take one back. */
export const DevicesTable: React.FC<DevicesTableProps> = ({ devices, onRevoke }) => {
  const { t } = useTerminal();
  // Which device the operator has clicked once. Revoking cuts off a real person
  // mid-session, so it takes a second, deliberate click rather than a single
  // stray tap on a phone-sized dashboard.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      key: 'device',
      header: t('admin.colDevice'),
      render: (device) => {
        const described = describeUserAgent(device.userAgent);
        return (
          <span className="text-tui-text" title={described.raw}>
            {described.label || t('admin.unknownDevice')}
          </span>
        );
      },
    },
    {
      key: 'deviceId',
      header: t('admin.colDeviceId'),
      render: (device) => <span className="text-tui-muted">{device.deviceId}</span>,
    },
    {
      key: 'ip',
      header: t('admin.colIp'),
      render: (device) => <span className="text-tui-muted">{device.lastIp || '—'}</span>,
    },
    {
      key: 'lastSeen',
      header: t('admin.colLastSeen'),
      render: (device) => (
        <span className="whitespace-nowrap text-tui-muted">
          {formatTimestamp(device.lastSeenAt)}
        </span>
      ),
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
            onBlur={() =>
              setPendingId((current) => (current === device.deviceId ? null : current))
            }
            aria-label={t('admin.revokeDevice')}
            className={isPending ? 'bg-tui-bad text-tui-crust' : undefined}
          >
            {isBusy ? (
              <Spinner />
            ) : isPending ? (
              t('admin.revokeConfirm')
            ) : (
              t('admin.revokeDevice')
            )}
          </Button>
        );
      },
    },
  ];

  return (
    <Panel title={t('admin.pairedDevicesTitle', { count: devices.length })} bodyClassName="-mx-1">
      <Table
        columns={columns}
        items={devices}
        rowKey={(device) => device.deviceId}
        empty={t('admin.noDevices')}
      />
    </Panel>
  );
};
