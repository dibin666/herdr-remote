import { useState } from 'react';
import { useConnection, useSettings, useTerminalIO, useToasts } from '@/context/TerminalContext';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { cn } from '@/shared/lib/cn';
import { CAP_BASE, CAP_IDLE } from './caps';
import { KeyIcon } from './KeyLabel';

/**
 * Opens a text box whose contents are typed into the terminal on send: the
 * fallback for browsers that cannot hand us the clipboard directly. Images and
 * files keep their own buttons beside it, so this one stays text-only.
 */
export function PasteButton({ capClass, vibrate }: { capClass: string; vibrate: () => void }) {
  const { t } = useSettings();
  const { isController } = useConnection();
  const { sendKey, warnViewerMode } = useTerminalIO();
  const { addToast } = useToasts();
  const [open, setOpen] = useState(false);

  const pasteText = (text: string) => {
    sendKey(text);
    addToast('success', t('clipboard.pasted'));
  };

  const handleClick = () => {
    vibrate();
    if (!isController) {
      warnViewerMode();
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        data-testid="paste-btn"
        onClick={handleClick}
        className={cn(CAP_BASE, capClass, CAP_IDLE)}
        title={t('clipboard.paste')}
        aria-label={t('clipboard.paste')}
      >
        <KeyIcon name="paste" />
        <span>{t('clipboard.paste')}</span>
      </button>
      <PasteFallbackModal
        isOpen={open}
        allowImage={false}
        onClose={() => setOpen(false)}
        onSend={pasteText}
      />
    </>
  );
}
