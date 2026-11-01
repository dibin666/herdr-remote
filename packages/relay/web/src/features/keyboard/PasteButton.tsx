import { useState } from 'react';
import type { PreparedImagePaste } from '@/features/paste/imagePaste';
import {
  useConnection,
  useSettings,
  useTerminalIO,
  useToasts,
  useUpload,
} from '@/context/TerminalContext';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { cn } from '@/shared/lib/cn';
import { CAP_BASE, CAP_IDLE } from './caps';
import { KeyIcon } from './KeyLabel';

/** A paste control that can read the clipboard on tap or accept typed text. */
export function PasteButton({
  squareKeyClass,
  vibrate,
}: {
  squareKeyClass: string;
  vibrate: () => void;
}) {
  const { t } = useSettings();
  const { isController } = useConnection();
  const { sendKey, warnViewerMode } = useTerminalIO();
  const { uploadImage } = useUpload();
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
        className={cn(CAP_BASE, squareKeyClass, CAP_IDLE)}
        title={t('clipboard.paste')}
        aria-label={t('clipboard.paste')}
      >
        <KeyIcon name="attach" />
      </button>
      <PasteFallbackModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onSend={(text) => {
          pasteText(text);
          setOpen(false);
        }}
        onSendImage={async (image: PreparedImagePaste) => {
          await uploadImage(image);
          setOpen(false);
        }}
      />
    </>
  );
}
