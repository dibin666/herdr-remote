// What the dashboard shows before it has anything to show: where a remote
// relay's own dashboard is, the operator sign-in, and a local relay refusing
// this device.

import type React from 'react';
import { cn } from '../../utils/cn';
import { PAIR_COMMAND } from '../../utils/pairCommand';
import { useCopyFeedback } from '../../utils/useCopyFeedback';
import { useSettings } from '../../context/TerminalContext';
import { Button, FieldLabel, GLYPH, Input, Notice, Panel, Row } from '../tui';

/** A remote relay reached through a profile on another origin. */
export const RemoteRelayGuide: React.FC<{
  wsUrl: string;
  adminUrl: string;
  onOpenRemoteAdmin: () => void;
  onSignIn: () => void;
}> = ({ wsUrl, adminUrl, onOpenRemoteAdmin, onSignIn }) => {
  const { t } = useSettings();
  return (
    <Panel title={t('admin.remoteRelayTitle')} bodyClassName="space-y-2">
      <p className="text-tui leading-snug text-tui-muted">{t('admin.remoteRelayNotice')}</p>

      <div className="space-y-0.5 border border-tui-border-dim bg-tui-mantle px-2 py-1.5">
        <Row label={t('admin.remoteRelayEndpoint')} labelWidth={18}>
          <code className="break-all text-tui-accent">{wsUrl}</code>
        </Row>
        <Row label={t('admin.remoteRelayAdminUrl')} labelWidth={18}>
          <code className="break-all text-tui-ok">{adminUrl}</code>
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onOpenRemoteAdmin} glyph={GLYPH.arrowRight}>
          {t('admin.openRemoteAdminBtn')}
        </Button>
        <Button onClick={onSignIn}>{t('admin.relayAdminLoginBtn')}</Button>
      </div>
    </Panel>
  );
};

/** Operator sign-in for the relay-wide dashboard. */
export const OperatorSignIn: React.FC<{
  adminConfigured: boolean | undefined;
  isAuthError: boolean;
  tokenInput: string;
  onTokenInput: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  isSameOriginRelay: boolean;
  onBackToTerminal?: () => void;
  showBack: boolean;
  onCancel: () => void;
}> = ({
  adminConfigured,
  isAuthError,
  tokenInput,
  onTokenInput,
  onSubmit,
  isSameOriginRelay,
  onBackToTerminal,
  showBack,
  onCancel,
}) => {
  const { t } = useSettings();
  return (
    <Panel title={t('admin.relayAdminTitle')} bodyClassName="space-y-2">
      {adminConfigured === false ? (
        <Notice tone="warn">{t('admin.relayAdminNotConfigured')}</Notice>
      ) : isAuthError ? (
        <Notice tone="bad">{t('admin.relayAdminAuthError')}</Notice>
      ) : (
        <Notice tone="accent">{t('admin.relayAdminPrompt')}</Notice>
      )}

      <form onSubmit={onSubmit} className="space-y-2">
        <div className="space-y-1">
          <FieldLabel htmlFor="relay-admin-token">{t('admin.relayAdminTokenLabel')}</FieldLabel>
          <Input
            id="relay-admin-token"
            type="password"
            autoComplete="current-password"
            value={tokenInput}
            onChange={(e) => onTokenInput(e.target.value)}
            placeholder={t('admin.relayAdminTokenPlaceholder')}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={!tokenInput.trim()}>
            {t('admin.relayAdminLoginBtn')}
          </Button>
          {isSameOriginRelay ? (
            onBackToTerminal && !showBack ? (
              <Button variant="ghost" onClick={onBackToTerminal}>
                {t('admin.returnToTerminal')}
              </Button>
            ) : null
          ) : (
            <Button variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
};

/** A local relay refusing this device's token: how to pair it. */
export const UnauthorizedPanel: React.FC<{
  onOpenPairing?: () => void;
  onRetry: () => void;
}> = ({ onOpenPairing, onRetry }) => {
  const { t } = useSettings();
  const { copied, copy } = useCopyFeedback();
  const copiedPairCmd = copied !== null;
  const handleCopyPairCmd = () => copy(PAIR_COMMAND, t('toasts.commandCopied'));
  return (
    <Panel title={t('admin.unauthorizedTitle')} tone="bad" bodyClassName="space-y-2">
      <Notice tone="bad">{t('admin.unauthorizedDesc')}</Notice>

      <div className="space-y-1.5 border border-tui-border-dim bg-tui-mantle px-2 py-1.5">
        <span className="block text-tui-sm uppercase text-tui-muted">
          {t('admin.pairingStepsTitle')}
        </span>
        <div className="flex items-center gap-2 border border-tui-border bg-tui-crust px-2 py-1">
          <span aria-hidden="true" className="shrink-0 select-none text-tui-ok">
            $
          </span>
          <code className="min-w-0 flex-1 truncate text-tui-text">{PAIR_COMMAND}</code>
          <Button
            onClick={handleCopyPairCmd}
            glyph={copiedPairCmd ? GLYPH.check : '⧉'}
            className={cn('shrink-0', copiedPairCmd && 'border-tui-ok text-tui-ok')}
          >
            {copiedPairCmd ? t('admin.copiedJson') : t('common.copy')}
          </Button>
        </div>
        <p className="text-tui-sm text-tui-faint">{t('admin.pairingStepsHelp')}</p>
      </div>

      <div className="flex items-center gap-2">
        {onOpenPairing && (
          <Button variant="primary" onClick={onOpenPairing}>
            {t('admin.enterPairCodeBtn')}
          </Button>
        )}
        <Button onClick={onRetry}>{t('admin.retryFetchBtn')}</Button>
      </div>
    </Panel>
  );
};
