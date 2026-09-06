import React from 'react';
import { PtyInfo } from '../../types/admin';
import { useTerminal } from '../../context/TerminalContext';
import { Column, Panel, Table } from '../tui';

interface PtysTableProps {
  ptys: PtyInfo[];
}

/** The shells the relay is holding open, and the geometry each one is at. */
export const PtysTable: React.FC<PtysTableProps> = ({ ptys }) => {
  const { t } = useTerminal();

  const columns: Column<PtyInfo>[] = [
    {
      key: 'id',
      header: t('admin.colPtyId'),
      render: (pty) => <span className="font-bold text-tui-accent">{pty.id}</span>,
    },
    {
      key: 'pid',
      header: t('admin.colPid'),
      width: 9,
      render: (pty) => <span className="text-tui-muted">{pty.pid}</span>,
    },
    {
      key: 'command',
      header: t('admin.colCommand'),
      render: (pty) => (
        <code className="border border-tui-border-dim bg-tui-mantle px-1 text-tui-text">
          {pty.command}
        </code>
      ),
    },
    {
      key: 'grid',
      header: t('admin.colGrid'),
      width: 11,
      render: (pty) => (
        <span className="whitespace-nowrap text-tui-muted">
          {pty.cols}
          <span aria-hidden="true" className="mx-0.5 text-tui-faint">
            ×
          </span>
          {pty.rows}
        </span>
      ),
    },
    {
      key: 'cwd',
      header: t('admin.colCwd'),
      className: 'max-w-xs truncate',
      render: (pty) => <span className="text-tui-muted">{pty.cwd || '~'}</span>,
    },
    {
      key: 'viewers',
      header: t('admin.colViewers'),
      align: 'right',
      width: 9,
      render: (pty) => <span className="font-bold text-tui-ok">{pty.activeClients}</span>,
    },
  ];

  return (
    <Panel title={t('admin.activePtysTitle', { count: ptys.length })} bodyClassName="-mx-1">
      <Table columns={columns} items={ptys} rowKey={(pty) => pty.id} empty={t('admin.noPtys')} />
    </Panel>
  );
};
