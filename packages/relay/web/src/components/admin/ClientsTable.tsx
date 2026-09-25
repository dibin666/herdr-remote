import React from 'react';
import { ConnectedClientInfo } from '../../types/admin';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';
import { Badge, Column, Panel, StatusDot, Table } from '../tui';
import { formatBytes, formatRelative, formatTimestamp } from './format';

interface ClientsTableProps {
  clients: ConnectedClientInfo[];
}

/**
 * Who is attached right now, and to which workstation.
 *
 * Every row can type: the windows share one terminal, and pairing is the
 * boundary. The role column says so per row rather than being dropped, because
 * "all of these can type" is the security-relevant fact an operator is here to
 * check — and a relay too old to have been updated would still show a row that
 * cannot. The host column only exists on the operator's relay-wide view; a
 * workstation's own view is all one host.
 */
export const ClientsTable: React.FC<ClientsTableProps> = ({ clients }) => {
  const { t } = useTerminal();
  const showHost = clients.some((client) => client.hostId);

  const columns: Column<ConnectedClientInfo>[] = [
    {
      key: 'id',
      header: t('admin.colClientId'),
      render: (c) => (
        <span className="flex items-center gap-1.5">
          <StatusDot level="ok" />
          <span className="font-bold text-tui-text">{c.id}</span>
        </span>
      ),
    },
    ...(showHost
      ? [
          {
            key: 'host',
            header: t('admin.colHost'),
            render: (c: ConnectedClientInfo) => (
              <span className="text-tui-text">{c.hostId || '—'}</span>
            ),
          },
        ]
      : []),
    {
      key: 'role',
      header: t('admin.colRole'),
      width: 10,
      render: (c) => {
        const isController = c.role === 'controller';
        return (
          <Badge tone={isController ? 'ok' : 'warn'} className="text-tui-sm">
            {isController ? t('common.controller') : t('common.viewer')}
          </Badge>
        );
      },
    },
    {
      key: 'device',
      header: t('admin.colDevice'),
      render: (c) => {
        const device = describeUserAgent(c.userAgent);
        // The full agent string stays reachable on hover; the cell itself shows
        // only what tells devices apart, and which pairing it signed in with.
        return (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={device.label ? 'text-tui-text' : 'text-tui-faint'} title={device.raw}>
              {device.label || t('admin.unknownDevice')}
            </span>
            {c.deviceId ? <code className="text-tui-sm text-tui-faint">{c.deviceId}</code> : null}
          </span>
        );
      },
    },
    {
      key: 'ip',
      header: t('admin.colIp'),
      render: (c) => <span className="text-tui-muted">{c.ip || '127.0.0.1'}</span>,
    },
    {
      key: 'connectedAt',
      header: t('admin.colConnectedAt'),
      render: (c) => (
        <span className="whitespace-nowrap text-tui-muted" title={formatTimestamp(c.connectedAt)}>
          {c.connectedAt ? formatRelative(c.connectedAt, t) : t('admin.startedRecently')}
        </span>
      ),
    },
    {
      key: 'traffic',
      header: t('admin.colTraffic'),
      align: 'right',
      render: (c) => (
        <span className="whitespace-nowrap">
          <span className="text-tui-accent">↓{formatBytes(c.bytesReceived || 0)}</span>
          <span aria-hidden="true" className="mx-1 text-tui-faint">
            /
          </span>
          <span className="text-tui-ok">↑{formatBytes(c.bytesSent || 0)}</span>
        </span>
      ),
    },
  ];

  return (
    <Panel
      title={t('admin.connectedClientsTitle', { count: clients.length })}
      bodyClassName="-mx-1"
    >
      <Table columns={columns} items={clients} rowKey={(c) => c.id} empty={t('admin.noClients')} />
    </Panel>
  );
};
