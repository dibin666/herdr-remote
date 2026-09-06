/**
 * WebUI Shortcut Management & Conflict Prevention
 * 
 * Ensures WebUI shortcuts NEVER intercept Herdr host / pane / tab shortcuts,
 * browser zoom (Ctrl +/-/0), or raw terminal keystrokes.
 * 
 * STRICT RULES:
 * 1. Never call preventDefault() or stopPropagation() on Ctrl, Alt, or Meta combinations.
 * 2. If the event originates in or is focused inside the terminal, ignore completely.
 * 3. Only modal/sheet-scoped Escape key is handled to dismiss open dialogs.
 */

/**
 * Detects if the keyboard event originates from or is targeted at the terminal.
 */
export function isEventFromTerminal(e: KeyboardEvent | Event): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;

  // Direct element check
  if (
    target.id === 'terminal-container' ||
    target.id === 'terminal-frame' ||
    target.id === 'terminal-surface' ||
    target.classList.contains('xterm-helper-textarea') ||
    target.classList.contains('xterm') ||
    target.closest('#terminal-container') ||
    target.closest('.xterm')
  ) {
    return true;
  }

  // Active element fallback
  if (typeof document !== 'undefined' && document.activeElement) {
    const active = document.activeElement as HTMLElement;
    if (
      active.id === 'terminal-container' ||
      active.classList.contains('xterm-helper-textarea') ||
      active.closest('#terminal-container') ||
      active.closest('.xterm')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether an event originated in an interactive input outside the terminal
 * (e.g. search input, modal input).
 */
export function isEventFromFormInput(e: KeyboardEvent | Event): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName.toUpperCase();
  return (
    (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') &&
    !target.classList.contains('xterm-helper-textarea')
  );
}

export interface WebUIShortcutHandlers {
  onCloseModals?: () => void;
}

/**
 * Attaches modal-scoped Escape listener for WebUI dialogs.
 * Absolutely no modifier chords (Ctrl, Alt, Meta) are intercepted or prevented.
 */
export function attachWebUIShortcuts(
  handlers: WebUIShortcutHandlers,
  options: { isModalOpen?: boolean; isSheetOpen?: boolean } = {}
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleKeyDown = (e: KeyboardEvent) => {
    // Strictly do not intercept any Ctrl, Alt, or Meta combinations
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }

    // If an open modal/sheet exists and Escape was pressed outside the terminal, close it
    if (e.key === 'Escape' && (options.isModalOpen || options.isSheetOpen)) {
      if (!isEventFromTerminal(e)) {
        e.preventDefault();
        e.stopPropagation();
        handlers.onCloseModals?.();
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => {
    window.removeEventListener('keydown', handleKeyDown);
  };
}
