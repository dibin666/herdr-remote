import React from 'react';
import { ConnectedClientInfo } from '../../types/admin';
import { ShieldCheck, Shield, Users, Globe } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useTerminal } from '../../context/TerminalContext';

interface ClientsTableProps {
  clients: ConnectedClientInfo[];
  activeControllerId?: string | null;
}

export const ClientsTable: React.FC<ClientsTableProps> = ({
  clients,
  activeControllerId,
}) => {
  const { t } = useTerminal();

  if (clients.length === 0) {
    return (
      <div className="p-8 text-center bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl text-charcoal-500 dark:text-charcoal-400 text-xs shadow-sm">
        <Users className="w-8 h-8 mx-auto mb-2 opacity-40 text-charcoal-400" />
        <p>{t('admin.noClients')}</p>
      </div>
    );
  }

  return (
    <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-sand-200 dark:border-charcoal-750 bg-sand-50 dark:bg-charcoal-900 flex items-center justify-between">
        <h3 className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-herdr-500" />
          <span>{t('admin.connectedClientsTitle', { count: clients.length })}</span>
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-charcoal-700 dark:text-charcoal-300">
          <thead className="bg-sand-100/70 dark:bg-charcoal-900/70 text-charcoal-500 dark:text-charcoal-400 uppercase text-[10px] font-semibold border-b border-sand-200 dark:border-charcoal-750">
            <tr>
              <th className="px-4 py-2.5">{t('admin.colClientId')}</th>
              <th className="px-4 py-2.5">{t('admin.colRole')}</th>
              <th className="px-4 py-2.5">{t('admin.colIp')}</th>
              <th className="px-4 py-2.5">{t('admin.colConnectedAt')}</th>
              <th className="px-4 py-2.5 text-right">{t('admin.colTraffic')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-200 dark:divide-charcoal-750 font-mono">
            {clients.map((c) => {
              const isController =
                c.role === 'controller' || c.id === activeControllerId;
              return (
                <tr key={c.id} className="hover:bg-sand-50 dark:hover:bg-charcoal-800 transition-colors">
                  <td className="px-4 py-3 font-semibold text-charcoal-900 dark:text-charcoal-100 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span>{c.id}</span>
                  </td>
                  <td className="px-4 py-3 font-sans">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
                        isController
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-800 dark:bg-emerald-950/80 dark:border-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-950/80 dark:border-amber-700 dark:text-amber-300'
                      )}
                    >
                      {isController ? (
                        <>
                          <ShieldCheck className="w-3 h-3" />
                          <span>{t('common.controller')}</span>
                        </>
                      ) : (
                        <>
                          <Shield className="w-3 h-3" />
                          <span>{t('common.viewer')}</span>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400">
                    <span className="flex items-center gap-1">
                      <Globe className="w-3 h-3 text-charcoal-400" />
                      <span>{c.ip || '127.0.0.1'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400 text-[11px]">
                    {c.connectedAt ? new Date(c.connectedAt).toLocaleTimeString() : t('admin.startedRecently')}
                  </td>
                  <td className="px-4 py-3 text-right text-charcoal-500 dark:text-charcoal-400 text-[11px]">
                    <span className="text-herdr-700 dark:text-herdr-300">{formatBytes(c.bytesReceived || 0)}</span> /{' '}
                    <span className="text-emerald-700 dark:text-emerald-300">{formatBytes(c.bytesSent || 0)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
