/**
 * Opening a link that was printed into the terminal — on the device looking at
 * it, not on the workstation.
 *
 * Herdr resolves a link by opening it on the machine the pane runs on. That is
 * the right answer for the workstation's own window and the wrong one for a
 * phone: the URL an agent just printed is meant for the pair of eyes reading
 * it. So the browser resolves links itself.
 *
 * Herdr 0.9.1 is what makes this dependable on the emitting side — a URL that
 * wraps across rows, or whose start or end is outside the viewport, stays one
 * link — so the scan below joins wrapped rows back into one logical line rather
 * than treating each row as its own text.
 *
 * Two ways in, because a terminal has two kinds of pointer:
 *   - desktop: xterm's own link layer, which needs Shift held while a pane has
 *     mouse reporting on (the same bypass every emulator uses, and the same
 *     shape as Herdr's own hold-Ctrl-to-highlight);
 *   - touch: the long-press menu, since a tap is already spoken for by mouse
 *     forwarding.
 */

import type { Terminal } from '@xterm/xterm';
import { pointToCell } from './terminalSelection';

/** What a terminal is allowed to talk this browser into opening. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Deliberately narrow: a scheme we will open, or a bare `www.` host. Anything
 * exotic is left as text rather than guessed at.
 */
const URL_PATTERN = /(?:https?:\/\/|mailto:|www\.)[^\s"'<>`]+/gi;

/** Punctuation that ends a sentence far more often than it ends a URL. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** How far a wrapped line is followed. Long enough for a URL, bounded for cost. */
const MAX_WRAPPED_ROWS = 8;

/** `www.example.com` is a link a human wrote; give it the scheme it implies. */
function withScheme(candidate: string): string {
  return /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
}

/**
 * Drop trailing characters that belong to the prose around the URL.
 *
 * A closing bracket is kept when the URL opened one — Wikipedia and issue
 * trackers both produce those — and dropped when it is the sentence's.
 */
function trimUrlTail(candidate: string): string {
  const count = (text: string, character: string) => text.split(character).length - 1;
  let url = candidate.replace(TRAILING_PUNCTUATION, '');
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    while (url.endsWith(close) && count(url, close) > count(url, open)) {
      url = url.slice(0, -1);
    }
  }
  return url;
}

/** Whether this is something the browser may be asked to open. */
export function isOpenableUrl(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(withScheme(candidate)).protocol);
  } catch {
    return false;
  }
}

/**
 * The URL covering `index` in `text`, or null.
 *
 * Returned in its original form so a caller can show the user what they are
 * about to open; `openTerminalLink` is what adds an implied scheme.
 */
export function findUrlAt(text: string, index: number): string | null {
  if (typeof text !== 'string' || index < 0) return null;
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    const url = trimUrlTail(match[0]);
    if (!url) continue;
    const start = match.index;
    const end = start + url.length;
    if (index >= start && index < end && isOpenableUrl(url)) return url;
  }
  return null;
}

/** The first URL anywhere in `text` — what a selection offers to open. */
export function findFirstUrl(text: string): string | null {
  if (typeof text !== 'string') return null;
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    const url = trimUrlTail(match[0]);
    if (url && isOpenableUrl(url)) return url;
  }
  return null;
}

/**
 * The logical line containing `bufferRow`, with the offset `col` lands on.
 *
 * xterm stores a wrapped line as several rows, each flagged `isWrapped`. A URL
 * that wraps is one string to a reader and several to the buffer, so the rows
 * are joined before anything is matched against them.
 */
export function logicalLineAt(
  term: Terminal,
  col: number,
  bufferRow: number,
): { text: string; index: number } | null {
  const buffer = term?.buffer?.active;
  if (!buffer || typeof buffer.getLine !== 'function') return null;
  if (!buffer.getLine(bufferRow)) return null;

  let start = bufferRow;
  for (let steps = 0; steps < MAX_WRAPPED_ROWS; steps += 1) {
    const line = buffer.getLine(start);
    if (!line?.isWrapped || start === 0) break;
    start -= 1;
  }

  let text = '';
  let index = -1;
  for (let row = start; row < start + MAX_WRAPPED_ROWS; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (row > start && !line.isWrapped) break;
    if (row === bufferRow) index = text.length + col;
    text += line.translateToString(false);
  }

  if (index < 0) return null;
  return { text, index };
}

/** The URL under a cell, following the line across any wrap. */
export function linkAtCell(term: Terminal, col: number, bufferRow: number): string | null {
  const logical = logicalLineAt(term, col, bufferRow);
  if (!logical) return null;
  return findUrlAt(logical.text, logical.index);
}

/**
 * The part of a link worth showing next to an "open" button.
 *
 * The host, not the path: it is what decides whether the tap is safe, and it is
 * the only part that reliably fits beside a label on a phone. A `mailto:` has
 * no host, so its address stands in.
 */
export function linkDisplayHost(candidate: string): string {
  try {
    const url = new URL(withScheme(candidate));
    return url.host || url.pathname;
  } catch {
    return '';
  }
}

/**
 * Open a link in this browser.
 *
 * `noopener,noreferrer` because the terminal's contents are whatever a remote
 * program printed: the new tab gets no handle back to this one, and no referrer
 * naming the relay. Returns false for anything outside the scheme allowlist.
 */
export function openTerminalLink(candidate: string): boolean {
  if (!isOpenableUrl(candidate)) return false;
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;
  window.open(withScheme(candidate), '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * The link xterm's linkifier is hovering, in its private shape. The public
 * API keeps it unreachable, so the read is defensive on every level.
 */
interface HoveredLink {
  text?: string;
  range?: {
    start?: { x?: number; y?: number };
    end?: { x?: number; y?: number };
  };
}

/**
 * The URL of the link the linkifier knows under `col`/`bufferRow`, or null.
 * Its range is 1-based columns and absolute 1-based buffer rows — the same
 * space `pointToCell`'s 0-based answer converts to by adding one.
 */
function linkifierLinkAt(term: Terminal, col: number, bufferRow: number): string | null {
  const link = (
    term as unknown as { _core?: { linkifier?: { currentLink?: { link?: HoveredLink } } } }
  )._core?.linkifier?.currentLink?.link;
  const start = link?.range?.start;
  const end = link?.range?.end;
  if (
    typeof link?.text !== 'string' ||
    typeof start?.x !== 'number' ||
    typeof start.y !== 'number' ||
    typeof end?.x !== 'number' ||
    typeof end.y !== 'number'
  ) {
    return null;
  }
  const cols = term.cols;
  const current = (bufferRow + 1) * cols + (col + 1);
  const lower = start.y * cols + start.x;
  const upper = end.y * cols + end.x;
  if (current < lower || current > upper) return null;
  return link.text;
}

/** The URL under a client point, whichever of the two link layers saw it. */
function linkAtPoint(
  term: Terminal,
  point: { clientX: number; clientY: number },
  scale: number,
): string | null {
  const cell = pointToCell(point, term, undefined, scale);
  if (!cell) return null;
  return (
    linkifierLinkAt(term, cell.col, cell.bufferRow) ?? linkAtCell(term, cell.col, cell.bufferRow)
  );
}

/**
 * A Ctrl/Cmd-click on a link opens it here and nowhere else.
 *
 * Without this the press is forwarded to the PTY — where Herdr opens the link
 * on the workstation (or, through the connector's openers, asks this window
 * for it) — while xterm's linkifier also activates it on the release. One
 * click, opens everywhere. Swallowing the press at capture keeps the whole
 * gesture local: Herdr never sees it, and the matching release is swallowed
 * too so the linkifier does not open the same link a second time.
 */
export function attachLinkClickBridge(
  container: HTMLElement,
  term: Terminal,
  getScale: () => number = () => 1.0,
): () => void {
  let swallowMouseUp = false;
  const onMouseDown = (event: MouseEvent) => {
    swallowMouseUp = false;
    // Shift means "select instead of reporting"; Alt is xterm's other bypass.
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    if (!event.ctrlKey && !event.metaKey) return;
    const url = linkAtPoint(term, event, getScale());
    if (!url || !isOpenableUrl(url)) return;
    event.preventDefault();
    event.stopPropagation();
    swallowMouseUp = true;
    term.focus();
    openTerminalLink(url);
  };
  const onMouseUp = (event: MouseEvent) => {
    if (!swallowMouseUp) return;
    swallowMouseUp = false;
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener('mousedown', onMouseDown, true);
  container.addEventListener('mouseup', onMouseUp, true);
  return () => {
    container.removeEventListener('mousedown', onMouseDown, true);
    container.removeEventListener('mouseup', onMouseUp, true);
  };
}
