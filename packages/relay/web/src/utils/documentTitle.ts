/**
 * The browser tab's name, taken from the terminal the window is watching.
 *
 * Herdr sets its window title with OSC 2, which xterm surfaces as
 * `onTitleChange`. Reading it only became honest with Herdr 0.9.1: before that
 * release a client's title could follow another client's selection, so a tab
 * would have announced work the window was not showing. With one Herdr client
 * per browser window, the title now names that window's own view — which is the
 * one thing that tells two identical-looking tabs apart.
 */

export const BASE_DOCUMENT_TITLE = 'Herdr Remote';

/** Long enough for "workspace — agent", short enough to leave a readable tab. */
const MAX_TITLE_LENGTH = 80;

/** C0, DEL and C1. Escaped rather than literal so the source stays copyable. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Make a terminal-supplied string safe to put in `document.title`.
 *
 * The title arrives from a remote program, so it is treated as hostile input:
 * control characters (which can hide text or fake a separator) are dropped
 * rather than escaped, whitespace runs are collapsed, and the result is
 * clamped. Returns an empty string when nothing printable is left.
 */
export function sanitizeTerminalTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * What the tab should say.
 *
 * The terminal's own title wins; the profile name is what a tab falls back to
 * between sessions, so a disconnected window still says which workstation it
 * belongs to instead of going anonymous.
 */
export function formatDocumentTitle(title?: string | null, fallback?: string | null): string {
  const terminalTitle = sanitizeTerminalTitle(title);
  if (terminalTitle) return `${terminalTitle} · ${BASE_DOCUMENT_TITLE}`;
  const profileName = sanitizeTerminalTitle(fallback);
  if (profileName) return `${profileName} · ${BASE_DOCUMENT_TITLE}`;
  return BASE_DOCUMENT_TITLE;
}

/** Apply the computed title, tolerating a document that is not there (tests, SSR). */
export function applyDocumentTitle(title?: string | null, fallback?: string | null): string {
  const next = formatDocumentTitle(title, fallback);
  if (typeof document !== 'undefined') document.title = next;
  return next;
}
