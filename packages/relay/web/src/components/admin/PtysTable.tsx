import React from 'react';
import { PtyInfo } from '../../types/admin';
import { Terminal, Cpu } from 'lucide-react';
import { useTerminal } from '../../context/TerminalContext';

interface PtysTableProps {
  ptys: PtyInfo[];
}

export const PtysTable: React.FC<PtysTableProps> = ({ ptys }) => {
  const { t } = useTerminal();

  if (ptys.length === 0) {
    return (
      <div className="p-8 text-center bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl text-charcoal-500 dark:text-charcoal-400 text-xs shadow-sm">
        <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40 text-charcoal-400" />
        <p>{t('admin.noPtys')}</p>
      </div>
    );
  }

  return (
    <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-sand-200 dark:border-charcoal-750 bg-sand-50 dark:bg-charcoal-900 flex items-center justify-between">
        <h3 className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-herdr-500" />
          <span>{t('admin.activePtysTitle', { count: ptys.length })}</span>
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-charcoal-700 dark:text-charcoal-300 font-mono">
          <thead className="bg-sand-100/70 dark:bg-charcoal-900/70 text-charcoal-500 dark:text-charcoal-400 uppercase text-[10px] font-semibold border-b border-sand-200 dark:border-charcoal-750">
            <tr>
              <th className="px-4 py-2.5">{t('admin.colPtyId')}</th>
              <th className="px-4 py-2.5">{t('admin.colPid')}</th>
              <th className="px-4 py-2.5">{t('admin.colCommand')}</th>
              <th className="px-4 py-2.5">{t('admin.colGrid')}</th>
              <th className="px-4 py-2.5">{t('admin.colCwd')}</th>
              <th className="px-4 py-2.5 text-right">{t('admin.colViewers')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-200 dark:divide-charcoal-750">
            {ptys.map((pty) => (
              <tr key={pty.id} className="hover:bg-sand-50 dark:hover:bg-charcoal-800 transition-colors">
                <td className="px-4 py-3 font-semibold text-herdr-700 dark:text-herdr-400">{pty.id}</td>
                <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400 flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-charcoal-400" />
                  <span>{pty.pid}</span>
                </td>
                <td className="px-4 py-3 text-charcoal-800 dark:text-charcoal-200 font-medium">
                  <code className="bg-sand-100 dark:bg-charcoal-900 px-1.5 py-0.5 rounded border border-sand-300 dark:border-charcoal-700">
                    {pty.command}
                  </code>
                </td>
                <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400">
                  {pty.cols} × {pty.rows}
                </td>
                <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400 truncate max-w-xs font-sans text-[11px]">
                  {pty.cwd || '~'}
                </td>
                <td className="px-4 py-3 text-right text-emerald-700 dark:text-emerald-400 font-semibold">
                  {pty.activeClients}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
