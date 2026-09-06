import { DISABLE_MOUSE } from './mouse/protocol.js';

const ESC = String.fromCharCode(27);

const ENTER_ALT_SCREEN = `${ESC}[?1049h${ESC}[H`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * Take over the alternate screen.
 *
 * Two reasons. The interface is full-screen, so the shell's scrollback should
 * come back untouched on exit. More importantly, mouse reports arrive in
 * absolute terminal coordinates while element positions are computed relative
 * to the Ink root — those only agree when the app starts at row 1. Rendering
 * under a shell prompt shifted every click down by however many lines happened
 * to be on screen.
 */
export function enterFullScreen(output: NodeJS.WriteStream = process.stdout): void {
  try {
    output.write(ENTER_ALT_SCREEN);
  } catch {
    // Not a terminal we can drive; rendering still works, clicks may be offset.
  }
}

/**
 * Undo everything we turned on.
 *
 * Ink and the mouse layer both clean up on an orderly unmount, but a signal or
 * an uncaught error bypasses that, and a terminal left in mouse-reporting mode
 * swallows text selection in every command the user runs afterwards. Writing
 * the sequences unconditionally is harmless when they were never enabled.
 */
export function restoreTerminal(output: NodeJS.WriteStream = process.stdout): void {
  try {
    output.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
  } catch {
    // The stream may already be closed during shutdown; nothing useful to do.
  }
}
