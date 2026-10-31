// The browser's own paste event: a clipboard image found in it goes straight
// to the host's upload path, before the terminal ever sees text.

import type { Terminal } from '@xterm/xterm';
import { extractImageFromClipboardEvent } from '@/shared/lib/clipboard';

/**
 * Listens for paste on the terminal's textarea and its container; the textarea
 * is where a focused terminal receives the event, the container covers the
 * rest. Returns the detach for both.
 */
export function attachNativeImagePaste({
  term,
  container,
  onPaste,
  isController,
  warnViewerMode,
  uploadImage,
}: {
  term: Terminal;
  container: HTMLElement;
  onPaste: () => void;
  isController: () => boolean;
  warnViewerMode: () => void;
  uploadImage: (image: Blob) => Promise<boolean>;
}): () => void {
  const handleNativePaste = async (e: ClipboardEvent) => {
    onPaste();
    const imageBlob = extractImageFromClipboardEvent(e);
    if (!imageBlob) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isController()) {
      warnViewerMode();
      return;
    }
    await uploadImage(imageBlob);
  };
  term.textarea?.addEventListener('paste', handleNativePaste);
  container.addEventListener('paste', handleNativePaste);
  return () => {
    term.textarea?.removeEventListener('paste', handleNativePaste);
    container.removeEventListener('paste', handleNativePaste);
  };
}
