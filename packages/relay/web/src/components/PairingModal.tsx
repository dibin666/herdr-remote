import React, { useState, useEffect } from 'react';
import { useTerminal } from '../context/TerminalContext';
import {
  X,
  Link2,
  Key,
  RefreshCw,
  Copy,
  Check,
  Power,
  Server,
  Zap,
} from 'lucide-react';
import { cn } from '../utils/cn';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PairingModal: React.FC<PairingModalProps> = ({ isOpen, onClose }) => {
  const {
    settings,
    updateSettings,
    connect,
    disconnect,
    connectionState,
    hostId,
    addToast,
    t,
  } = useTerminal();

  const [wsUrl, setWsUrl] = useState(settings.wsUrl);
  const [token, setToken] = useState(settings.token);
  const [pairCode, setPairCode] = useState(settings.pairCode);
  const [clientId, setClientId] = useState(settings.clientId);
  const [autoReconnect, setAutoReconnect] = useState(settings.autoReconnect);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setWsUrl(settings.wsUrl);
      setToken(settings.token);
      setPairCode(settings.pairCode);
      setClientId(settings.clientId);
      setAutoReconnect(settings.autoReconnect);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleSaveAndConnect = (e: React.FormEvent) => {
    e.preventDefault();
    updateSettings({
      wsUrl: wsUrl.trim() || '/ws/client',
      token: token.trim(),
      pairCode: pairCode.trim().toUpperCase(),
      clientId: clientId.trim() || settings.clientId,
      autoReconnect,
    });

    disconnect();
    setTimeout(() => {
      connect({
        wsUrl: wsUrl.trim() || '/ws/client',
        token: token.trim() || undefined,
        pairCode: pairCode.trim().toUpperCase() || undefined,
        clientId: clientId.trim() || settings.clientId,
        autoReconnect,
      });
    }, 100);

    onClose();
  };

  const handleGenerateClientId = () => {
    const newId = `client-${Math.random().toString(36).substring(2, 8)}`;
    setClientId(newId);
  };

  const handleCopyShareUrl = () => {
    const url = new URL(window.location.href);
    url.search = '';
    if (pairCode.trim()) {
      url.searchParams.set('pairCode', pairCode.trim().toUpperCase());
    }
    // NEVER include long-lived tokens in share URL
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopiedLink(true);
      addToast('success', t('toasts.pairingLinkCopied'));
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  return (
    // Measured against the visible viewport, so a phone never has to scroll to
    // reveal a dialog that `vh` sized behind the browser's own chrome.
    <div
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center p-4 bg-charcoal-950/60 backdrop-blur-sm animate-in fade-in"
      style={{ height: 'var(--app-height, 100dvh)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pairing-modal-title"
    >
      <div
        className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col"
        style={{ maxHeight: 'calc(var(--app-height, 100dvh) - 2rem)' }}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-sand-200 dark:border-charcoal-750 flex items-center justify-between bg-sand-50 dark:bg-charcoal-900">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-herdr-100 dark:bg-herdr-950 border border-herdr-300 dark:border-herdr-700 flex items-center justify-center text-herdr-600 dark:text-herdr-400 shadow-sm">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h2 id="pairing-modal-title" className="font-semibold text-sm sm:text-base text-charcoal-900 dark:text-charcoal-100">
                {t('pairing.title')}
              </h2>
              <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400">{t('pairing.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 p-1.5 rounded-lg hover:bg-sand-200 dark:hover:bg-charcoal-800 transition-colors"
            aria-label={t('common.closeDialog')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current status bar */}
        <div className="px-5 py-2.5 bg-sand-100/60 dark:bg-charcoal-900/60 border-b border-sand-200 dark:border-charcoal-750 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-charcoal-500 dark:text-charcoal-400">{t('common.status')}:</span>
            <span
              className={cn(
                'font-semibold capitalize',
                connectionState === 'connected'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : connectionState === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
              )}
            >
              {connectionState}
            </span>
          </div>
          {hostId && (
            <div className="text-charcoal-500 dark:text-charcoal-400 font-mono text-[11px]">
              {t('common.host')}: <span className="text-herdr-700 dark:text-herdr-400 font-medium">{hostId}</span>
            </div>
          )}
        </div>

        {/* Form Body */}
        <form onSubmit={handleSaveAndConnect} className="p-5 flex-1 overflow-y-auto space-y-4 text-xs">
          {/* Pair Code */}
          <div>
            <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1">
              {t('pairing.pairCodeLabel')} <span className="text-charcoal-400 font-normal">{t('pairing.pairCodeNote')}</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-charcoal-400">
                <Zap className="w-4 h-4 text-herdr-500" />
              </div>
              <input
                type="text"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                placeholder={t('pairing.pairCodePlaceholder')}
                maxLength={12}
                className="w-full bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl pl-9 pr-3 py-2 text-charcoal-900 dark:text-charcoal-100 font-mono uppercase tracking-widest placeholder:text-charcoal-400 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
              />
            </div>
            <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 mt-1">
              {t('pairing.pairCodeHelp')}
            </p>
          </div>

          {/* Auth Token */}
          <div>
            <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1">
              {t('pairing.tokenLabel')} <span className="text-charcoal-400 font-normal">{t('pairing.tokenNote')}</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-charcoal-400">
                <Key className="w-4 h-4" />
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('pairing.tokenPlaceholder')}
                className="w-full bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl pl-9 pr-3 py-2 text-charcoal-900 dark:text-charcoal-100 font-mono placeholder:text-charcoal-400 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
              />
            </div>
          </div>

          {/* WebSocket URL */}
          <div>
            <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1">
              {t('pairing.wsUrlLabel')}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-charcoal-400">
                <Server className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
                placeholder={t('pairing.wsUrlPlaceholder')}
                className="w-full bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl pl-9 pr-3 py-2 text-charcoal-900 dark:text-charcoal-100 font-mono placeholder:text-charcoal-400 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
              />
            </div>
            <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 mt-1">
              {t('pairing.wsUrlDefaultNote')}
            </p>
          </div>

          {/* Client ID */}
          <div>
            <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1">
              {t('pairing.clientIdLabel')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="flex-1 bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl px-3 py-2 text-charcoal-900 dark:text-charcoal-100 font-mono placeholder:text-charcoal-400 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
              />
              <button
                type="button"
                onClick={handleGenerateClientId}
                className="px-3 py-2 bg-sand-200 hover:bg-sand-300 dark:bg-charcoal-700 dark:hover:bg-charcoal-600 text-charcoal-700 dark:text-charcoal-200 rounded-xl border border-sand-300 dark:border-charcoal-600 flex items-center gap-1 transition-colors font-medium"
                title={t('pairing.regenerateClientIdTitle')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('pairing.newIdButton')}</span>
              </button>
            </div>
          </div>

          {/* Auto reconnect toggle */}
          <div className="flex items-center justify-between py-2 border-t border-sand-200 dark:border-charcoal-750">
            <div>
              <span className="text-charcoal-700 dark:text-charcoal-300 font-medium block">{t('pairing.autoReconnectLabel')}</span>
              <span className="text-[11px] text-charcoal-500 dark:text-charcoal-400">{t('pairing.autoReconnectDesc')}</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={autoReconnect}
                onChange={(e) => setAutoReconnect(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-sand-300 dark:bg-charcoal-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-paper after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-herdr-700"></div>
            </label>
          </div>

          {/* Share Link button */}
          <div className="pt-2">
            <button
              type="button"
              onClick={handleCopyShareUrl}
              className="w-full py-2.5 px-3 bg-sand-100 hover:bg-sand-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-750 text-charcoal-700 dark:text-charcoal-200 rounded-xl border border-sand-300 dark:border-charcoal-700 flex items-center justify-center gap-2 transition-colors font-medium"
            >
              {copiedLink ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
              <span>{t('pairing.copyDirectLink')}</span>
            </button>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2 pt-4 border-t border-sand-200 dark:border-charcoal-750">
            {connectionState === 'connected' && (
              <button
                type="button"
                onClick={() => {
                  disconnect();
                  onClose();
                }}
                className="px-4 py-2.5 rounded-xl bg-red-50 hover:bg-red-100 dark:bg-red-950/80 dark:hover:bg-red-900 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 font-semibold flex items-center gap-1.5 transition-colors"
              >
                <Power className="w-4 h-4" />
                <span>{t('common.disconnect')}</span>
              </button>
            )}
            <button
              type="submit"
              className="flex-1 py-2.5 px-4 rounded-xl bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white font-semibold flex items-center justify-center gap-1.5 shadow-md transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{t('pairing.saveAndConnect')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
