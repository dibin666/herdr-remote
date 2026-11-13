export const TERMINAL_TOUCH_DRAG_THRESHOLD_PX = 8;

/** Only the read-only terminal mirrors may use the browser's edit menu. */
export function nativeCopyField(target: EventTarget | null): HTMLTextAreaElement | null {
  return target instanceof HTMLTextAreaElement &&
    target.readOnly &&
    target.hasAttribute('data-terminal-copy-field')
    ? target
    : null;
}

/** Input selections live on the control, not in window.getSelection(). */
export function nativeCopySelection(container: HTMLElement): HTMLTextAreaElement | null {
  const field = nativeCopyField(document.activeElement);
  return field && container.contains(field) && field.selectionStart !== field.selectionEnd
    ? field
    : null;
}
