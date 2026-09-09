/**
 * Fallback modal for manual clipboard pasting.
 *
 * Why this is necessary:
 * In insecure contexts (e.g. plain HTTP on LAN), `navigator.clipboard.readText`
 * is stripped by the browser security sandbox and `execCommand('paste')` is permanently
 * disabled. The browser will only permit pasting via a native focused user-input element.
 *
 * This modal renders an autofocus textarea so mobile users can long-press native paste,
 * followed by a Send button that passes the text directly to `term.paste(value)`.
 */

import React, { useState, useEffect } from 'react';
import { Modal, Button } from './tui';
import { useTerminal } from '../context/TerminalContext';

export interface PasteFallbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}

export const PasteFallbackModal: React.FC<PasteFallbackModalProps> = ({
  isOpen,
  onClose,
  onSend,
}) => {
  const { t } = useTerminal();
  const [value, setValue] = useState('');

  // Reset input content whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setValue('');
    }
  }, [isOpen]);

  const handleSend = () => {
    if (value) {
      onSend(value);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('clipboard.pasteTitle')}
      closeLabel={t('clipboard.cancel')}
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('clipboard.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSend} disabled={!value}>
            {t('clipboard.pasteSend')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 p-3 font-mono select-text">
        <label htmlFor="paste-fallback-input" className="text-tui-sm text-tui-muted">
          {t('clipboard.pasteHint')}
        </label>
        <textarea
          id="paste-fallback-input"
          autoFocus
          rows={5}
          className="tui-input w-full resize-none p-2 text-tui font-mono"
          placeholder={t('clipboard.pasteHint')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </Modal>
  );
};
