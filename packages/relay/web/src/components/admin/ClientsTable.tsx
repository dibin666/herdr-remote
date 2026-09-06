import React from 'react';
import { ConnectedClientInfo } from '../../types/admin';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';
import { Badge, Column, Panel, StatusDot, Table } from '../tui';

interface ClientsTableProps {
  clients: ConnectedClientInfo[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Who is attached right now.
 *
 * Every row can type: the windows share one terminal, and pairing is the
 * boundary. The role column says so per row rather than being dropped, because
 * "all of these can type" is the security-relevant fact an operator is here to
 * check — and a relay too old to have been updated would still show a row that
 * cannot.
 */
export const ClientsTable: React.FC<ClientsTableProps> = ({ clients }) => {
  const { t } = useTerminal();

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
    {
      key: 'role',
      header: t('admin.colRole'),
      width: 12,
      render: (c) => {
        const isController = c.role === 'controller';
        return (
          <Badge tone={isController ? 'ok' : 'warn'}>
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
        if (!device.label) {
          return <span className="text-tui-faint">{t('admin.unknownDevice')}</span>;
        }
        // The full agent string stays reachable on hover; the cell itself shows
        // only what tells devices apart.
        return (
          <span className="text-tui-muted" title={device.raw}>
            {device.label}
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
        <span className="text-tui-muted">
          {c.connectedAt ? new Date(c.connectedAt).toLocaleTimeString() : t('admin.startedRecently')}
        </span>
      ),
    },
    {
      key: 'traffic',
      header: t('admin.colTraffic'),
      align: 'right',
      render: (c) => (
        <span className="whitespace-nowrap">
          <span className="text-tui-accent">{formatBytes(c.bytesReceived || 0)}</span>
          <span aria-hidden="true" className="mx-1 text-tui-faint">
            /
          </span>
          <span className="text-tui-ok">{formatBytes(c.bytesSent || 0)}</span>
        </span>
      ),
    },
  ];

  return (
    <Panel
      title={t('admin.connectedClientsTitle', { count: clients.length })}
      bodyClassName="-mx-1"
    >
      <Table
        columns={columns}
        items={clients}
        rowKey={(c) => c.id}
        empty={t('admin.noClients')}
      />
    </Panel>
  );
};
