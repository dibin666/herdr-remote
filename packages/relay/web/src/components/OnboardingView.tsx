import React, { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import {
  Zap,
  Copy,
  Check,
  ShieldCheck,
  Terminal as TerminalIcon,
  ChevronDown,
  ChevronUp,
  Key,
  Server,
  Sparkles,
  RefreshCw,
} from 'lucide-react';

interface OnboardingViewProps {
  onPairedSuccess?: () => void;
}

export const OnboardingView: React.FC<OnboardingViewProps> = ({ onPairedSuccess }) => {
  const { settings, updateSettings, connect, connectionState, stateDetail, addToast, t } =
    useTerminal();

  const [pairCodeInput, setPairCodeInput] = useState('');
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced settings fields
  const [wsUrl, setWsUrl] = useState(settings.wsUrl || '/ws/client');
  const [token, setToken] = useState(settings.token || '');
  const [clientId, setClientId] = useState(settings.clientId || '');

  const PAIR_COMMAND = 'node bin/service.js pair';
  const CONFIG_TUI_COMMAND = 'node bin/config-tui.js';
  const HERDR_PANE_COMMAND = 'herdr plugin pane open --plugin herdr.remote.web --entrypoint config --placement zoomed --focus';

  const handleCopyCommand = (cmd: string) => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCommand(cmd);
      addToast('success', t('toasts.commandCopied'));
      setTimeout(() => setCopiedCommand(null), 2000);
    });
  };

  const handlePairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = pairCodeInput.trim().toUpperCase();
    if (!code && !token.trim()) {
      addToast('warning', t('toasts.connectionError'));
      return;
    }

    const updates: Partial<typeof settings> = {
      pairCode: code,
      wsUrl: wsUrl.trim() || '/ws/client',
      clientId: clientId.trim() || settings.clientId,
    };

    if (token.trim()) {
      updates.token = token.trim();
    }

    updateSettings(updates);

    // Trigger connection
    connect({
      pairCode: code || undefined,
      token: token.trim() || undefined,
      wsUrl: wsUrl.trim() || '/ws/client',
      clientId: clientId.trim() || settings.clientId,
    });

    if (onPairedSuccess) {
      onPairedSuccess();
    }
  };

  const isConnecting = connectionState === 'connecting' || connectionState === 'reconnecting';

  return (
    <div className="flex-1 w-full h-full overflow-y-auto bg-sand-100 dark:bg-charcoal-950 p-4 sm:p-6 md:p-8 flex items-center justify-center">
      <div className="max-w-lg w-full bg-paper dark:bg-charcoal-850 rounded-2xl border border-sand-300 dark:border-charcoal-700 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header Badge & Title */}
        <div className="p-6 sm:p-8 border-b border-sand-200 dark:border-charcoal-750 bg-sand-50/70 dark:bg-charcoal-900/60">
          <div className="flex items-center gap-3.5 mb-3">
            <div className="w-11 h-11 rounded-xl bg-herdr-100 dark:bg-herdr-950 border border-herdr-300 dark:border-herdr-700 flex items-center justify-center text-herdr-600 dark:text-herdr-400 shadow-sm">
              <TerminalIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold text-charcoal-900 dark:text-charcoal-100 tracking-tight">
                  {t('onboarding.title')}
                </h1>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-herdr-100 dark:bg-herdr-900/50 text-herdr-700 dark:text-herdr-300 border border-herdr-200 dark:border-herdr-700">
                  {t('onboarding.firstTimeSetup')}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-charcoal-500 dark:text-charcoal-400 mt-0.5">
                {t('onboarding.description')}
              </p>
            </div>
          </div>

          {/* Connection Error Banner if 401 / auth required */}
          {connectionState === 'error' && (
            <div className="mt-4 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-start justify-between gap-3 shadow-sm">
              <div className="flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold block">{t('onboarding.authRequired')}</span>
                  <span className="opacity-90">
                    {stateDetail || t('onboarding.authRequiredDesc')}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => connect()}
                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t('common.retry')}</span>
              </button>
            </div>
          )}
        </div>

        {/* Step-by-Step Pairing Form */}
        <form onSubmit={handlePairSubmit} className="p-6 sm:p-8 space-y-6">
          {/* Step 1: Generate Code */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-charcoal-700 dark:text-charcoal-300 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-sand-200 dark:bg-charcoal-700 text-charcoal-800 dark:text-charcoal-200 text-xs flex items-center justify-center font-bold">
                  1
                </span>
                {t('onboarding.step1Title')}
              </label>
            </div>
            <p className="text-xs text-charcoal-500 dark:text-charcoal-400">
              {t('onboarding.step1Desc')}
            </p>

            <div className="flex items-center gap-2 bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl p-2.5">
              <code className="flex-1 font-mono text-xs sm:text-sm text-charcoal-900 dark:text-charcoal-100 font-semibold px-2 truncate">
                {PAIR_COMMAND}
              </code>
              <button
                type="button"
                onClick={() => handleCopyCommand(PAIR_COMMAND)}
                className="px-3 py-1.5 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 text-charcoal-700 dark:text-charcoal-200 border border-sand-300 dark:border-charcoal-600 text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0 shadow-sm"
              >
                {copiedCommand === PAIR_COMMAND ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-emerald-700 dark:text-emerald-300">{t('common.copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('common.copy')}</span>
                  </>
                )}
              </button>
            </div>

            {/* Alternative TUI commands */}
            <div className="space-y-1 text-[11px] text-charcoal-500 dark:text-charcoal-400 pt-1">
              <div className="flex items-center justify-between">
                <span>{t('onboarding.step1CopyPlugin')}</span>
                <button
                  type="button"
                  onClick={() => handleCopyCommand(HERDR_PANE_COMMAND)}
                  className="text-herdr-700 dark:text-herdr-400 font-medium hover:underline text-[11px]"
                >
                  {copiedCommand === HERDR_PANE_COMMAND ? t('common.copied') : t('onboarding.step1CopyCli')}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span>{t('onboarding.step1TuiNote')}</span>
                <code
                  onClick={() => handleCopyCommand(CONFIG_TUI_COMMAND)}
                  className="font-mono bg-sand-200 dark:bg-charcoal-700 px-1.5 py-0.5 rounded cursor-pointer hover:underline text-charcoal-800 dark:text-charcoal-200"
                  title={t('common.clickToCopy')}
                >
                  {CONFIG_TUI_COMMAND}
                </code>
              </div>
            </div>
          </div>

          {/* Step 2: Enter Code */}
          <div className="space-y-2.5 pt-2 border-t border-sand-200 dark:border-charcoal-750">
            <label className="text-xs font-semibold uppercase tracking-wider text-charcoal-700 dark:text-charcoal-300 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-herdr-100 dark:bg-herdr-950 text-herdr-700 dark:text-herdr-400 text-xs flex items-center justify-center font-bold">
                2
              </span>
              {t('onboarding.step2Title')}
            </label>

            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-charcoal-400">
                <Zap className="w-5 h-5 text-herdr-500" />
              </div>
              <input
                type="text"
                value={pairCodeInput}
                onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
                placeholder={t('onboarding.step2Placeholder')}
                maxLength={12}
                autoFocus
                className="w-full bg-sand-50 dark:bg-charcoal-900 border-2 border-sand-300 dark:border-charcoal-600 rounded-xl pl-11 pr-4 py-3 text-lg font-mono font-bold tracking-widest text-charcoal-900 dark:text-white uppercase placeholder:text-charcoal-400 dark:placeholder:text-charcoal-600 focus:outline-none focus:border-herdr-500 focus:ring-2 focus:ring-herdr-500/20 transition-all shadow-inner"
              />
            </div>
            <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400">
              {t('onboarding.step2Note')}
            </p>
          </div>

          {/* Primary Action Button */}
          <div>
            <button
              type="submit"
              disabled={isConnecting}
              className="w-full py-3.5 px-5 rounded-xl bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white font-bold text-sm sm:text-base flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
            >
              {isConnecting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>{t('onboarding.connectingAndPairing')}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>{t('onboarding.connectAndPair')}</span>
                </>
              )}
            </button>
          </div>

          {/* Advanced Connection Options (Accordion) */}
          <div className="pt-2 border-t border-sand-200 dark:border-charcoal-750">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full py-1.5 flex items-center justify-between text-xs font-medium text-charcoal-500 hover:text-charcoal-800 dark:text-charcoal-400 dark:hover:text-charcoal-200 transition-colors"
            >
              <span>{t('onboarding.advancedTitle')}</span>
              {showAdvanced ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3.5 bg-sand-50 dark:bg-charcoal-900/60 p-4 rounded-xl border border-sand-200 dark:border-charcoal-750 text-xs">
                {/* Manual Auth Token */}
                <div>
                  <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1 flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-charcoal-500" />
                    <span>{t('onboarding.manualTokenLabel')}</span>
                  </label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={t('onboarding.manualTokenPlaceholder')}
                    className="w-full bg-paper dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-lg px-3 py-2 text-charcoal-800 dark:text-charcoal-100 font-mono focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
                  />
                </div>

                {/* WebSocket URL */}
                <div>
                  <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1 flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5 text-charcoal-500" />
                    <span>{t('onboarding.wsEndpointLabel')}</span>
                  </label>
                  <input
                    type="text"
                    value={wsUrl}
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder={t('onboarding.wsEndpointPlaceholder')}
                    className="w-full bg-paper dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-lg px-3 py-2 text-charcoal-800 dark:text-charcoal-100 font-mono focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
                  />
                </div>

                {/* Client ID */}
                <div>
                  <label className="block text-charcoal-700 dark:text-charcoal-300 font-medium mb-1">
                    {t('onboarding.clientIdLabel')}
                  </label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="w-full bg-paper dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-lg px-3 py-2 text-charcoal-800 dark:text-charcoal-100 font-mono focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
                  />
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
