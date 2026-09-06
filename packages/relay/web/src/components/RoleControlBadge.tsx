import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { Button, GLYPH, Modal, Notice, StatusDot } from './tui';

/**
 * Who holds the input lease, and the one control that changes it.
 *
 * The lease is the most consequential piece of state in the client — it decides
 * whether your keystrokes reach a live agent — so it is stated in words next to
 * a coloured dot, never encoded in a pill you have to have learnt. `●` in green
 * is control; `●` in yellow is read-only; `○` is a session that is not there.
 */
export const RoleControlBadge: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const {
    role,
    controllerId,
    assignedClientId,
    connectionState,
    claimControl,
    releaseControl,
    t,
  } = useTerminal();

  const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);

  const isConnected = connectionState === 'connected';
  const isController = role === 'controller';
  const hasActiveController = Boolean(controllerId);
  const isAnotherController =
    !isController && hasActiveController && controllerId !== assignedClientId;

  if (!isConnected) {
    return (
      <div
        className="inline-flex select-none items-center gap-1.5 text-tui uppercase text-tui-faint"
        role="status"
        aria-label={t('terminal.offlineStatusAria')}
      >
        <StatusDot level="idle" />
        <span>{t('common.offline')}</span>
      </div>
    );
  }

  const handleConfirmTakeover = () => {
    setShowTakeoverConfirm(false);
    claimControl(true);
  };

  return (
    <>
      <div className={cn('flex items-center gap-2', !compact && 'w-full')}>
        <div
          className={cn(
            'inline-flex min-w-0 select-none items-center gap-1.5 text-tui uppercase',
            !compact && 'flex-1',
            isController ? 'text-tui-ok' : 'text-tui-warn'
          )}
          role="status"
          aria-label={isController ? t('role.controllerMode') : t('role.viewerMode')}
        >
          <StatusDot level={isController ? 'ok' : 'warn'} />
          <span className={cn('truncate', compact && 'hidden lg:inline')}>
            {isController
              ? t('role.controlActive')
              : compact
                ? t('common.viewer')
                : isAnotherController
                  ? t('role.viewerWithController', { controllerId: controllerId || '' })
                  : t('role.viewerReadOnly')}
          </span>
        </div>

        {isController ? (
          <Button
            variant="ghost"
            onClick={releaseControl}
            aria-label={t('terminal.releaseControlAria')}
            title={t('role.releaseControlTitle')}
            className="shrink-0"
          >
            {t('role.releaseControl')}
          </Button>
        ) : isAnotherController ? (
          <Button
            variant="warn"
            onClick={() => setShowTakeoverConfirm(true)}
            aria-label={t('terminal.takeoverControlAria')}
            title={t('role.takeoverControlTitle', { controllerId: controllerId || '' })}
            className="shrink-0"
          >
            {t('role.takeoverControl')}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => claimControl(false)}
            aria-label={t('terminal.claimControlAria')}
            title={t('role.claimControlTitle')}
            className="shrink-0"
          >
            {t('role.claimControl')}
          </Button>
        )}
      </div>

      {/*
       * The mobile control sheet has its own scroll container. A fixed
       * descendant of that surface is clipped to the sheet instead of the
       * visual viewport (the confirmation dialog would start below the phone's
       * bottom edge). Keep the dialog in document.body so fixed really means
       * viewport-fixed, regardless of which shell opened it.
       */}
      {showTakeoverConfirm &&
        typeof document !== 'undefined' &&
        createPortal(
          <Modal
            isOpen
            onClose={() => setShowTakeoverConfirm(false)}
            title={t('role.takeoverModalTitle')}
            closeLabel={t('common.closeDialog')}
            size="sm"
            hints={[{ keys: 'esc', action: t('common.cancel') }]}
            footer={
              <>
                <Button variant="ghost" onClick={() => setShowTakeoverConfirm(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="warn" onClick={handleConfirmTakeover}>
                  {t('role.confirmTakeover')}
                </Button>
              </>
            }
          >
            <div className="space-y-2">
              <Notice tone="warn">{t('role.takeoverModalDesc')}</Notice>
              <p className="pl-1 text-tui leading-snug text-tui-muted">
                <span aria-hidden="true" className="mr-1 text-tui-faint">
                  {GLYPH.arrowRight}
                </span>
                {t('role.takeoverModalWarning')}
              </p>
              {controllerId ? (
                <p className="pl-1 text-tui-sm text-tui-faint">
                  {t('role.takeoverControlTitle', { controllerId })}
                </p>
              ) : null}
            </div>
          </Modal>,
          document.body
        )}
    </>
  );
};
