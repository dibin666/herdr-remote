// A file pasted on the workstation arrives as the path to type into this terminal.
import type { Terminal } from '@xterm/xterm';
import { type RefObject, useEffect } from 'react';
import type { Translate } from '@/shared/i18n';
import { useLatest } from './useLatest';

export function usePasteActions(options: {
  termRef: RefObject<Terminal | null>;
  addToast: (type: 'success', message: string) => void;
  t: Translate;
  onPaste: () => void;
  subscribeToPasteFileReady: (handler: (path: string) => void) => () => void;
}): void {
  const live = useLatest(options);
  const { termRef, subscribeToPasteFileReady } = options;
  useEffect(
    () =>
      subscribeToPasteFileReady((path) => {
        const term = termRef.current;
        if (!term) return;
        live.current.onPaste();
        term.paste(path);
        live.current.addToast('success', live.current.t('clipboard.pasted'));
      }),
    [subscribeToPasteFileReady, termRef, live],
  );
}
