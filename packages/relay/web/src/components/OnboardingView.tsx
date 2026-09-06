import React, { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import {
  Button,
  FieldLabel,
  GLYPH,
  Input,
  Notice,
  Panel,
  Rule,
  Spinner,
} from './tui';

interface OnboardingViewProps {
  onPairedSuccess?: () => void;
}

/**
 * The first screen: a device that has never paired.
 *
 * Written as a terminal walkthrough rather than a signup card. The command you
 * are asked to run is shown at a `$` prompt because that is where it will be
 * typed, the steps are numbered `[1]` `[2]` the way a TUI wizard numbers them,
 * and the advanced fields are folded behind a `▸`/`▾` disclosure instead of a
 * second screen.
 */
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
  const HERDR_PANE_COMMAND =
    'herdr plugin pane open --plugin herdr.remote.web --entrypoint config --placement zoomed --focus';

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

  const StepNumber: React.FC<{ n: number }> = ({ n }) => (
    <span aria-hidden="true" className="shrink-0 font-bold text-tui-accent">
      [{n}]
    </span>
  );

  return (
    <div className="flex h-full w-full flex-1 items-start justify-start overflow-y-auto bg-tui-crust p-2 sm:p-4">
      <div className="w-full max-w-5xl space-y-3">
        {/* Banner: the program announcing itself, as a terminal program does. */}
        <div className="border border-tui-border bg-tui-base px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span aria-hidden="true" className="font-bold text-tui-accent">
              herdr-remote
            </span>
            <h1 className="text-tui font-bold text-tui-text">{t('onboarding.title')}</h1>
            <span className="text-tui uppercase text-tui-warn">
              {t('onboarding.firstTimeSetup')}
            </span>
          </div>
          <p className="mt-0.5 text-tui leading-snug text-tui-muted">
            {t('onboarding.description')}
          </p>
        </div>

        {connectionState === 'error' && (
          <Notice
            tone="warn"
            action={
              <Button variant="warn" onClick={() => connect()}>
                {t('common.retry')}
              </Button>
            }
          >
            <span className="block font-bold">{t('onboarding.authRequired')}</span>
            <span className="block text-tui-muted">
              {stateDetail || t('onboarding.authRequiredDesc')}
            </span>
          </Notice>
        )}

        <form onSubmit={handlePairSubmit} className="grid gap-3 md:grid-cols-2">
          {/* Step 1 — run this on the workstation */}
          <Panel title={t('onboarding.step1Title')} className="min-w-0">
            <div className="space-y-2">
              <p className="flex items-start gap-2 text-tui text-tui-muted">
                <StepNumber n={1} />
                <span className="leading-snug">{t('onboarding.step1Desc')}</span>
              </p>

              <div className="flex items-center gap-2 border border-tui-border bg-tui-mantle px-2 py-1">
                <span aria-hidden="true" className="shrink-0 select-none text-tui-ok">
                  $
                </span>
                <code className="min-w-0 flex-1 truncate text-tui text-tui-text">
                  {PAIR_COMMAND}
                </code>
                <Button
                  onClick={() => handleCopyCommand(PAIR_COMMAND)}
                  glyph={copiedCommand === PAIR_COMMAND ? GLYPH.check : '⧉'}
                  className={cn('shrink-0', copiedCommand === PAIR_COMMAND && 'border-tui-ok text-tui-ok')}
                >
                  {copiedCommand === PAIR_COMMAND ? t('common.copied') : t('common.copy')}
                </Button>
              </div>

              <div className="space-y-0.5 text-tui-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-tui-faint">{t('onboarding.step1CopyPlugin')}</span>
                  <button
                    type="button"
                    onClick={() => handleCopyCommand(HERDR_PANE_COMMAND)}
                    className="tui-focusable shrink-0 text-tui-accent underline-offset-2 hover:underline"
                  >
                    {copiedCommand === HERDR_PANE_COMMAND
                      ? t('common.copied')
                      : t('onboarding.step1CopyCli')}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-tui-faint">{t('onboarding.step1TuiNote')}</span>
                  <code
                    onClick={() => handleCopyCommand(CONFIG_TUI_COMMAND)}
                    className="shrink-0 cursor-pointer border border-tui-border-dim px-1 text-tui-muted hover:border-tui-accent hover:text-tui-accent"
                    title={t('common.clickToCopy')}
                  >
                    {CONFIG_TUI_COMMAND}
                  </code>
                </div>
              </div>
            </div>
          </Panel>

          {/* Step 2 — type the code it printed */}
          <Panel title={t('onboarding.step2Title')} className="min-w-0">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <StepNumber n={2} />
                <Input
                  type="text"
                  value={pairCodeInput}
                  onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
                  placeholder={t('onboarding.step2Placeholder')}
                  maxLength={12}
                  autoFocus
                  aria-label={t('onboarding.step2Title')}
                  className="font-bold uppercase"
                />
              </div>
              <p className="text-tui-sm leading-snug text-tui-faint">{t('onboarding.step2Note')}</p>
            </div>
          </Panel>

          <Button variant="primary" type="submit" block disabled={isConnecting} className="py-1.5 md:col-span-2">
            {isConnecting ? (
              <Spinner label={t('onboarding.connectingAndPairing')} />
            ) : (
              t('onboarding.connectAndPair')
            )}
          </Button>

          {/* Advanced — folded away, the way a TUI folds a rarely-used section */}
          <div className="border border-tui-border bg-tui-base md:col-span-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
              className="tui-focusable flex w-full items-center gap-2 px-2 py-1 text-left text-tui text-tui-muted transition-colors hover:text-tui-accent"
            >
              <span aria-hidden="true" className="text-tui-accent">
                {showAdvanced ? GLYPH.chevronDown : GLYPH.chevronRight}
              </span>
              <span className="uppercase">{t('onboarding.advancedTitle')}</span>
            </button>

            {showAdvanced && (
              <div className="space-y-2.5 border-t border-tui-border-dim px-2 py-2">
                <div className="space-y-1">
                  <FieldLabel htmlFor="onboarding-token">
                    {t('onboarding.manualTokenLabel')}
                  </FieldLabel>
                  <Input
                    id="onboarding-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={t('onboarding.manualTokenPlaceholder')}
                  />
                </div>

                <div className="space-y-1">
                  <FieldLabel htmlFor="onboarding-ws">
                    {t('onboarding.wsEndpointLabel')}
                  </FieldLabel>
                  <Input
                    id="onboarding-ws"
                    type="text"
                    value={wsUrl}
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder={t('onboarding.wsEndpointPlaceholder')}
                  />
                </div>

                <Rule />

                <div className="space-y-1">
                  <FieldLabel htmlFor="onboarding-client-id">
                    {t('onboarding.clientIdLabel')}
                  </FieldLabel>
                  <Input
                    id="onboarding-client-id"
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
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
