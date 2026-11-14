import type React from 'react';
import { useState } from 'react';
import { useSettings, useConnection, useToasts } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { useCopyFeedback } from '@/context/useCopyFeedback';
import { Button, FieldLabel, GLYPH, Input, Notice, Panel, Rule, Spinner } from '@/shared/ui';
import { WS_CLIENT_PATH } from '@protocol/messages';
import { PAIR_COMMAND, TUI_COMMAND } from './pairCommand';

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
  const { settings, updateSettings, t } = useSettings();
  const { connect, connectionState, stateDetail } = useConnection();
  const { addToast } = useToasts();

  const [pairCodeInput, setPairCodeInput] = useState('');
  const { copied: copiedCommand, copy } = useCopyFeedback();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced settings fields
  const [wsUrl, setWsUrl] = useState(settings.wsUrl || WS_CLIENT_PATH);
  const [token, setToken] = useState(settings.token || '');
  const [clientId, setClientId] = useState(settings.clientId || '');

  const handleCopyCommand = (cmd: string) => copy(cmd, t('toasts.commandCopied'));

  const submitPair = (codeOverride?: string) => {
    const code = (codeOverride ?? pairCodeInput).trim().toUpperCase();
    if (!code && !token.trim()) {
      addToast('warning', t('pairing.credentialsRequired'));
      return;
    }

    const updates: Partial<typeof settings> = {
      pairCode: code,
      wsUrl: wsUrl.trim() || WS_CLIENT_PATH,
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
      wsUrl: wsUrl.trim() || WS_CLIENT_PATH,
      clientId: clientId.trim() || settings.clientId,
    });

    if (onPairedSuccess) {
      onPairedSuccess();
    }
  };

  const handlePairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitPair();
  };

  const isConnecting = connectionState === 'connecting' || connectionState === 'reconnecting';

  /* The code is exactly six characters: typed into six cells, and the last
     cell submitting the form is what a printed code asks for next anyway. */
  const PAIR_CODE_LENGTH = 6;
  const handleCodeChange = (raw: string) => {
    const cleaned = raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, PAIR_CODE_LENGTH);
    setPairCodeInput(cleaned);
    if (cleaned.length === PAIR_CODE_LENGTH) submitPair(cleaned);
  };

  const StepNumber: React.FC<{ n: number }> = ({ n }) => (
    <span aria-hidden="true" className="shrink-0 font-bold text-tui-accent">
      [{n}]
    </span>
  );

  return (
    /*
     * Centred, both ways.
     *
     * This is the only thing on the screen and the only thing the visitor can
     * do, so it belongs in the middle of the window rather than pinned to the
     * top-left corner of an otherwise empty terminal. `my-auto` inside a
     * scrolling column is what centres it without ever clipping it: on a short
     * window the margins collapse and the panel scrolls normally, which
     * `items-center` alone would not do.
     */
    <div className="flex h-full w-full flex-1 justify-center overflow-y-auto bg-tui-crust p-2 sm:p-4">
      {/* Centred on a desktop window; on a phone the card starts at the top
          instead of floating in the lower half it has to share with a
          keyboard. */}
      <div className="mb-auto mt-4 w-full max-w-3xl space-y-3 sm:my-auto sm:mt-0">
        {/* Banner: the program announcing itself, as a terminal program does. */}
        <div className="border border-tui-border bg-tui-base px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h1 className="text-tui font-bold text-tui-accent">{t('onboarding.title')}</h1>
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

        <form onSubmit={handlePairSubmit} className="grid gap-3">
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
                  className={cn(
                    'shrink-0',
                    copiedCommand === PAIR_COMMAND && 'border-tui-ok text-tui-ok',
                  )}
                >
                  {copiedCommand === PAIR_COMMAND ? t('common.copied') : t('common.copy')}
                </Button>
              </div>

              <div className="space-y-0.5 text-tui-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-tui-faint">{t('onboarding.step1TuiNote')}</span>
                  <button
                    type="button"
                    onClick={() => handleCopyCommand(TUI_COMMAND)}
                    className="shrink-0 cursor-pointer border border-tui-border-dim px-1 text-tui-muted hover:border-tui-accent hover:text-tui-accent"
                    title={t('common.clickToCopy')}
                  >
                    <code>{TUI_COMMAND}</code>
                    <span aria-hidden="true" className="ml-1 text-tui-faint">
                      {copiedCommand === TUI_COMMAND ? GLYPH.check : '⧉'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </Panel>

          {/* Step 2 — type the code it printed */}
          <Panel title={t('onboarding.step2Title')} className="min-w-0">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <StepNumber n={2} />
                <div className="relative min-w-0 flex-1">
                  <input
                    type="text"
                    value={pairCodeInput}
                    onChange={(e) => handleCodeChange(e.target.value)}
                    maxLength={PAIR_CODE_LENGTH}
                    // biome-ignore lint/a11y/noAutofocus: the code is the only thing this screen asks for
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="characters"
                    inputMode="text"
                    aria-label={t('onboarding.step2Title')}
                    className="tui-focusable absolute inset-0 z-10 h-full w-full opacity-0"
                  />
                  <div aria-hidden="true" className="grid grid-cols-6 gap-1">
                    {Array.from({ length: PAIR_CODE_LENGTH }, (_, i) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells are fixed positions, never reordered
                        key={i}
                        className={cn(
                          'flex h-11 items-center justify-center border text-tui font-bold uppercase',
                          pairCodeInput[i]
                            ? 'border-tui-accent bg-tui-mantle text-tui-text'
                            : 'border-tui-border bg-tui-mantle text-tui-faint',
                          i === pairCodeInput.length && 'border-tui-accent-bright',
                        )}
                      >
                        {pairCodeInput[i] ?? ''}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="text-tui-sm leading-snug text-tui-faint">{t('onboarding.step2Note')}</p>
            </div>
          </Panel>

          <Button variant="primary" type="submit" block disabled={isConnecting} className="py-1.5">
            {isConnecting ? (
              <Spinner label={t('onboarding.connectingAndPairing')} />
            ) : (
              t('onboarding.connectAndPair')
            )}
          </Button>

          {/* Advanced — folded away, the way a TUI folds a rarely-used section */}
          <div className="border border-tui-border bg-tui-base">
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
                  <FieldLabel htmlFor="onboarding-ws">{t('onboarding.wsEndpointLabel')}</FieldLabel>
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
