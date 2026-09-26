// Pasting into the terminal: from the clipboard where the browser allows it,
// through a fallback dialog where it does not, and the path of an image the
// workstation saved.

import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import type { Translate } from '@/shared/i18n';
import { readClipboardImage, readClipboardText } from '@/shared/lib/clipboard';
import type { PreparedImagePaste } from '@/features/paste/imagePaste';
import { useLatest } from './useLatest';

export function usePasteActions(options: {
  termRef: RefObject<Terminal | null>;
  isController: boolean;
  warnViewerMode: () => void;
  uploadImage: (image: Blob | PreparedImagePaste) => Promise<boolean>;
  addToast: (type: 'success' | 'info', message: string) => void;
  t: Translate;
  /** Typed-ahead predictions are void once a paste changes the input. */
  onPaste: () => void;
  subscribeToPasteFileReady: (handler: (path: string) => void) => () => void;
}) {
  const live = useLatest(options);
  const { termRef, subscribeToPasteFileReady } = options;
  const [isPasteFallbackOpen, setIsPasteFallbackOpen] = useState(false);

  /** Paste text as typed input, and say so. */
  const pasteText = useCallback(
    (term: Terminal, text: string) => {
      live.current.onPaste();
      term.paste(text);
      live.current.addToast('success', live.current.t('clipboard.pasted'));
    },
    [live],
  );

  /** The terminal, when this window may type into it; a viewer is told why not. */
  const typingTerminal = useCallback((): Terminal | null => {
    const term = termRef.current;
    if (!term) return null;
    if (!live.current.isController) {
      live.current.warnViewerMode();
      return null;
    }
    return term;
  }, [termRef, live]);

  const handlePaste = useCallback(async () => {
    const term = typingTerminal();
    if (!term) return;
    // 1. Best-effort probe clipboard for images (HTTPS or localhost)
    try {
      const imageResult = await readClipboardImage();
      if (imageResult.ok) {
        await live.current.uploadImage(imageResult.blob);
        return;
      }
    } catch {
      // Best-effort image probe; do not throw or toast on denial/insecure
    }

    // 2. Best-effort probe clipboard for plain text
    try {
      const result = await readClipboardText();
      if (result.ok) {
        pasteText(term, result.text);
        return;
      } else if (result.reason === 'empty') {
        live.current.addToast('info', live.current.t('clipboard.pasteUnavailable'));
        return;
      }
    } catch {
      // Fall through to manual modal
    }

    // 3. Fallback modal: Reliable universal interface for text and image entry
    setIsPasteFallbackOpen(true);
  }, [typingTerminal, pasteText, live]);

  const handleFallbackPasteSend = useCallback(
    (text: string) => {
      const term = typingTerminal();
      if (term) pasteText(term, text);
    },
    [typingTerminal, pasteText],
  );

  const handleFallbackImageSend = useCallback(
    (image: PreparedImagePaste) => {
      if (typingTerminal()) live.current.uploadImage(image);
    },
    [typingTerminal, live],
  );

  // The workstation saved a pasted image: its path is what gets typed.
  useEffect(
    () =>
      subscribeToPasteFileReady((path) => {
        const term = termRef.current;
        if (term) pasteText(term, path);
      }),
    [subscribeToPasteFileReady, termRef, pasteText],
  );

  return {
    isPasteFallbackOpen,
    closePasteFallback: () => setIsPasteFallbackOpen(false),
    handlePaste,
    handleFallbackPasteSend,
    handleFallbackImageSend,
  };
}
