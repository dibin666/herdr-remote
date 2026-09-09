/**
 * Universal clipboard read/write adapter.
 *
 * Why this exists:
 *
 * Herdr Relay defaults to serving over plain HTTP (`http://` on local/tailscale networks).
 * Modern browsers treat non-localhost HTTP as an insecure context, which completely
 * strips `navigator.clipboard` (it is `undefined`).
 *
 * Simply calling `navigator.clipboard.writeText()` causes hard runtime exceptions
 * on mobile browsers accessing the relay over a LAN IP. We need a robust three-tier
 * degradation for writes, and an honest failure breakdown for reads so the UI can
 * pop an accessible manual paste fallback modal.
 *
 * Write degradation:
 *   1. `navigator.clipboard.writeText`: Fast path for HTTPS and localhost.
 *   2. `document.execCommand('copy')`: Synchronous fallback for plain HTTP LAN access.
 *      Crucial implementation details:
 *       - The temporary textarea MUST explicitly declare `user-select: text` because
 *         the app root (`App.tsx:229`) declares `select-none` (`user-select: none`),
 *         which inherits down and silently destroys programmatic text selection.
 *       - Positioning must use `position: fixed; top: 0; left: 0; opacity: 0;`.
 *         `display: none` causes browsers to refuse selection entirely, while large
 *         negative coordinates (e.g. `left: -9999px`) trigger viewport jump/scroll on iOS.
 *       - iOS Safari requires `createRange` + `selectNodeContents` + `setSelectionRange`.
 *   3. 'failed': Both methods failed or threw.
 *
 * Read strategy:
 *   - Only `navigator.clipboard.readText` exists. `execCommand('paste')` has been
 *     thoroughly deprecated and disabled across all modern browsers due to privacy
 *     restrictions; attempting it is a dead end.
 *   - When reading fails, we return structured reasons (`insecure` | `denied` | `empty`)
 *     so callers know exactly when to trigger the manual paste dialog.
 */

export type ClipboardCopyResult = 'clipboard' | 'exec' | 'failed';

export type ClipboardReadFailureReason = 'insecure' | 'denied' | 'empty';

export type ClipboardReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: ClipboardReadFailureReason };

/**
 * Copies text to the system clipboard using the best available browser mechanism.
 */
export async function copyText(text: string): Promise<ClipboardCopyResult> {
  // Tier 1: Modern asynchronous Clipboard API (HTTPS or localhost).
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    } catch {
      // SecurityError, NotAllowedError, or iframe permission policy rejection;
      // fall through to execCommand.
    }
  }

  // Tier 2: Synchronous document.execCommand('copy') fallback (HTTP LAN access).
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    let textarea: HTMLTextAreaElement | null = null;
    let savedSelectionRange: Range | null = null;
    let originalSelection: Selection | null = null;

    try {
      textarea = document.createElement('textarea');

      // CRITICAL: App.tsx:229 wraps the entire application in `select-none` (Tailwind
      // user-select: none). If we do not explicitly countermand that here, the browser
      // refuses to create a selection inside the textarea and execCommand copies empty text.
      textarea.style.userSelect = 'text';
      textarea.style.webkitUserSelect = 'text';

      // Position invisibly at the top-left corner without affecting layout.
      // Do NOT use display: none (cannot be selected) or negative coordinates
      // (iOS Safari will jump/scroll the viewport to the off-screen element).
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.padding = '0';
      textarea.style.border = 'none';
      textarea.style.outline = 'none';
      textarea.style.boxShadow = 'none';
      textarea.style.background = 'transparent';
      textarea.style.opacity = '0';
      textarea.style.fontSize = '16px'; // Prevent iOS auto-zoom on focus

      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.value = text;

      // Preserve any active user selection outside the terminal so we don't clobber it.
      if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        originalSelection = window.getSelection();
        if (originalSelection && originalSelection.rangeCount > 0) {
          savedSelectionRange = originalSelection.getRangeAt(0);
        }
      }

      document.body.appendChild(textarea);

      const isIOS =
        typeof navigator !== 'undefined' &&
        (/iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
          (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1));

      if (isIOS) {
        // iOS Safari ignores textarea.select() in several scenarios. Creating an explicit
        // DOM Range and binding it to window selection is the most reliable approach.
        const range = document.createRange();
        range.selectNodeContents(textarea);
        if (originalSelection) {
          originalSelection.removeAllRanges();
          originalSelection.addRange(range);
        }
        textarea.setSelectionRange(0, text.length);
      } else {
        textarea.focus({ preventScroll: true });
        textarea.select();
      }

      const successful = document.execCommand('copy');
      if (successful) {
        return 'exec';
      }
    } catch {
      // execCommand is unsupported or blocked by host policy.
    } finally {
      if (textarea && textarea.parentNode) {
        textarea.parentNode.removeChild(textarea);
      }
      // Restore previous document selection if one existed.
      if (originalSelection) {
        originalSelection.removeAllRanges();
        if (savedSelectionRange) {
          originalSelection.addRange(savedSelectionRange);
        }
      }
    }
  }

  // Tier 3: All avenues exhausted.
  return 'failed';
}

/**
 * Reads plain text from the system clipboard.
 *
 * In modern browsers, reading the clipboard requires `navigator.clipboard.readText()`.
 * `execCommand('paste')` is not implemented here because modern browsers permanently
 * disable it for unprivileged scripts to prevent background clipboard snooping.
 *
 * Returns a typed failure reason so callers can trigger a user-guided paste dialog.
 */
export async function readClipboardText(): Promise<ClipboardReadResult> {
  const isSecure = typeof window === 'undefined' || window.isSecureContext !== false;

  if (
    !isSecure ||
    typeof navigator === 'undefined' ||
    !navigator.clipboard ||
    typeof navigator.clipboard.readText !== 'function'
  ) {
    return { ok: false, reason: 'insecure' };
  }

  try {
    const text = await navigator.clipboard.readText();
    if (!text || text.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    return { ok: true, text };
  } catch (err: unknown) {
    // If the browser threw SecurityError because context became insecure or iframe disallowed
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return { ok: false, reason: 'insecure' };
    }

    const errorName = (err as { name?: string })?.name;
    if (errorName === 'SecurityError') {
      return { ok: false, reason: 'insecure' };
    }

    // NotAllowedError (permission denied / document not focused) or unknown error
    return { ok: false, reason: 'denied' };
  }
}
