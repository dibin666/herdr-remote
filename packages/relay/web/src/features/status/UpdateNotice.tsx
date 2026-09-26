import type React from 'react';
import { useState } from 'react';
import { useSettings, useConnection, useToasts } from '@/context/TerminalContext';
import { copyText } from '@/shared/lib/clipboard';
import { cn } from '@/shared/lib/cn';
import { Button, GLYPH, Modal, Row } from '@/shared/ui';

/**
 * The workstation's herdr-remote is behind the newest release.
 *
 * A chip on the status line rather than a banner: a banner would take a row
 * from the terminal, and this is news for the next quiet moment, not for now.
 * The chip opens how to update. Nothing here updates the workstation itself:
 * a button in a browser that installs software on another machine is not one
 * to add for convenience.
 */
/**
 * Whether the chip has anything to say. The status line separates segments by
 * which ones exist, so it has to ask before adding the chip, not after.
 */
export function useUpdateNoticeVisible(): boolean {
  const { updateStatus, ignoredUpdate } = useConnection();
  return Boolean(updateStatus?.updateAvailable) && ignoredUpdate !== updateStatus?.latest;
}

export const UpdateChip: React.FC<{ compact?: boolean; className?: string }> = ({
  compact = false,
  className,
}) => {
  const { t } = useSettings();
  const { updateStatus } = useConnection();
  const visible = useUpdateNoticeVisible();
  const [open, setOpen] = useState(false);

  if (!visible || !updateStatus) return null;

  const { latest, restartPending } = updateStatus;
  const label = restartPending
    ? t('update.chipRestart', { version: latest })
    : compact
      ? t('update.chipCompact', { version: latest })
      : t('update.chip', { version: latest });

  return (
    <>
      <button
        type="button"
        data-testid="update-chip"
        onClick={() => setOpen(true)}
        title={t('update.title')}
        className={cn(
          'tui-focusable shrink-0 whitespace-nowrap px-1 text-tui-warn hover:underline',
          className,
        )}
      >
        {label}
      </button>
      <UpdateModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};

const Command: React.FC<{ command: string }> = ({ command }) => {
  const { t } = useSettings();
  const { addToast } = useToasts();
  return (
    <div className="flex items-center gap-2 border border-tui-border bg-tui-mantle px-2 py-1">
      <span aria-hidden="true" className="shrink-0 select-none text-tui-ok">
        $
      </span>
      {/* Wraps rather than truncates: a command cut off at "herdr-remote…" is one nobody can type. */}
      <code className="min-w-0 flex-1 break-all text-tui-text">{command}</code>
      <Button
        glyph="⧉"
        className="shrink-0"
        onClick={() => {
          void copyText(command).then((result) => {
            addToast(
              result === 'failed' ? 'error' : 'success',
              result === 'failed' ? t('clipboard.copyFailed') : t('toasts.commandCopied'),
            );
          });
        }}
      >
        {t('common.copy')}
      </Button>
    </div>
  );
};

const UpdateModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useSettings();
  const { updateStatus, ignoreUpdate, hostname, hostId } = useConnection();
  if (!updateStatus) return null;
  const { current, installed, latest, restartPending } = updateStatus;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('update.title')}
      closeLabel={t('common.closeDialog')}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              ignoreUpdate(latest);
              onClose();
            }}
          >
            {t('update.ignore')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="update-modal">
        <div className="space-y-0.5">
          <Row label={t('common.host')} labelWidth={10}>
            {hostname || hostId || '—'}
          </Row>
          <Row label={t('update.running')} labelWidth={10}>
            {current}
          </Row>
          {installed !== current ? (
            <Row label={t('update.installed')} labelWidth={10}>
              {installed}
            </Row>
          ) : null}
          <Row label={t('update.latest')} labelWidth={10}>
            <span className="text-tui-ok">{latest}</span>
          </Row>
        </div>

        {restartPending ? (
          <>
            <p className="leading-snug text-tui-text">
              {t('update.restartPending', { version: installed })}
            </p>
            <Command command="herdr-remote restart" />
          </>
        ) : (
          <>
            <p className="leading-snug text-tui-text">
              <span aria-hidden="true" className="mr-1 text-tui-accent">
                {GLYPH.arrowRight}
              </span>
              {t('update.stepTui')}
            </p>
            <p className="leading-snug text-tui-muted">{t('update.stepCli')}</p>
            <Command command={`npm install -g herdr-remote@${latest} --prefer-online`} />
            <Command command="herdr-remote restart" />
            <p className="text-tui-sm leading-snug text-tui-faint">{t('update.restartNote')}</p>
          </>
        )}
      </div>
    </Modal>
  );
};
