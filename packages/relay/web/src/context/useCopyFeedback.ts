import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings, useToasts } from './TerminalContext';
import { copyText } from '@/shared/lib/clipboard';

/** How long a copy button shows that it worked. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * Copy text to the clipboard and say so. `copied` is the text last copied,
 * for a moment afterwards, so a button can show a check while it holds.
 */
export function useCopyFeedback() {
  const { t } = useSettings();
  const { addToast } = useToasts();
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string, message: string, tone: 'success' | 'info' = 'success') => {
      void copyText(text).then((result) => {
        if (result === 'failed') {
          addToast('error', t('clipboard.copyFailed'));
          return;
        }
        setCopied(text);
        addToast(tone, message);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
      });
    },
    [addToast, t],
  );

  return { copied, copy };
}
