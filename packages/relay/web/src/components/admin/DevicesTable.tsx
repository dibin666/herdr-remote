import React, { useState } from 'react';
import { PairedDeviceInfo } from '../../types/admin';
import { Smartphone, Globe, Trash2, Loader2, KeyRound } from 'lucide-react';
import { describeUserAgent } from '../../utils/userAgent';
import { useTerminal } from '../../context/TerminalContext';

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

export const DevicesTable: React.FC<DevicesTableProps> = ({ devices, onRevoke }) => {
  const { t } = useTerminal();
  // Which device the operator has clicked once. Revoking cuts off a real person
  // mid-session, so it takes a second, deliberate click rather than a single
  // stray tap on a phone-sized dashboard.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <div className="p-8 text-center bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl text-charcoal-500 dark:text-charcoal-400 text-xs shadow-sm">
        <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-40 text-charcoal-400" />
        <p>{t('admin.noDevices')}</p>
      </div>
    );
  }

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

  return (
    <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-sand-200 dark:border-charcoal-750 bg-sand-50 dark:bg-charcoal-900">
        <h3 className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5 text-herdr-500" />
          <span>{t('admin.pairedDevicesTitle', { count: devices.length })}</span>
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-charcoal-700 dark:text-charcoal-300">
          <thead className="bg-sand-100/70 dark:bg-charcoal-900/70 text-charcoal-500 dark:text-charcoal-400 uppercase text-[10px] font-semibold border-b border-sand-200 dark:border-charcoal-750">
            <tr>
              <th className="px-4 py-2.5">{t('admin.colDevice')}</th>
              <th className="px-4 py-2.5">{t('admin.colDeviceId')}</th>
              <th className="px-4 py-2.5">{t('admin.colIp')}</th>
              <th className="px-4 py-2.5">{t('admin.colLastSeen')}</th>
              <th className="px-4 py-2.5 text-right">{t('admin.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-200 dark:divide-charcoal-750">
            {devices.map((device) => {
              const described = describeUserAgent(device.userAgent);
              const isPending = pendingId === device.deviceId;
              const isBusy = busyId === device.deviceId;
              return (
                <tr key={device.deviceId} className="hover:bg-sand-50 dark:hover:bg-charcoal-800 transition-colors">
                  <td className="px-4 py-3 text-charcoal-900 dark:text-charcoal-100">
                    <span className="flex items-center gap-1.5" title={described.raw}>
                      <Smartphone className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
                      <span className="font-medium">
                        {described.label || t('admin.unknownDevice')}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-charcoal-500 dark:text-charcoal-400">
                    {device.deviceId}
                  </td>
                  <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400">
                    <span className="flex items-center gap-1">
                      <Globe className="w-3 h-3 text-charcoal-400" />
                      <span className="font-mono text-[11px]">{device.lastIp || '—'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-charcoal-500 dark:text-charcoal-400 text-[11px]">
                    {formatTimestamp(device.lastSeenAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRevoke(device.deviceId)}
                      onBlur={() => setPendingId((current) => (current === device.deviceId ? null : current))}
                      aria-label={t('admin.revokeDevice')}
                      className={[
                        'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-60',
                        isPending
                          ? 'bg-red-600 border-red-600 text-white hover:bg-red-700'
                          : 'bg-transparent border-sand-300 dark:border-charcoal-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40',
                      ].join(' ')}
                    >
                      {isBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Trash2 className="w-3 h-3" />
                      )}
                      <span>{isPending ? t('admin.revokeConfirm') : t('admin.revokeDevice')}</span>
                    </button>
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
