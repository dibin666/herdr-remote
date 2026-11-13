// The key bar button that opens the file list dialog, next to the uploads it
// complements: they send files in, this one brings files out.

import { useState } from 'react';
import { useConnection, useSettings, useTerminalIO } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { CAP_BASE, CAP_IDLE } from '@/features/keyboard/caps';
import { KeyIcon } from '@/features/keyboard/KeyLabel';
import { FileListModal } from './FileListModal';

export function FileListButton({
  capClass,
  vibrate,
  iconOnly = false,
}: {
  capClass: string;
  vibrate?: () => void;
  /** Phone shell: caps stay square, the name lives in the tooltip. */
  iconOnly?: boolean;
}) {
  const { t } = useSettings();
  const { isController } = useConnection();
  const { warnViewerMode } = useTerminalIO();
  const [open, setOpen] = useState(false);

  const handleClick = () => {
    vibrate?.();
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
        data-testid="file-list-btn"
        onClick={handleClick}
        className={cn(CAP_BASE, capClass, CAP_IDLE)}
        title={t('virtualKeyboard.fileListTitle')}
        aria-label={t('virtualKeyboard.fileList')}
      >
        <KeyIcon name="folder" />
        {!iconOnly && <span>{t('virtualKeyboard.fileList')}</span>}
      </button>
      <FileListModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
