/**
 * OSC 52 (`ESC ] 52 ; <target> ; <base64> ST`) is how a program asks its
 * terminal to write the clipboard. xterm implements neither write nor read,
 * so a remote program's request would die here — while Herdr on a workstation
 * without clipboard tools (headless, no `wl-copy`/`xclip`/`xsel`) emits
 * exactly this sequence as its fallback. Bridging writes into this window's
 * own clipboard covers what the connector's clipboard-tool shims cannot: a
 * workstation with no clipboard of its own.
 *
 * Read queries (`?` payloads) are swallowed without an answer: the window's
 * clipboard only leaves through the `clipboard_read` protocol path, where a
 * read exists because that window's session asked for it — never because a
 * program probed the terminal unprompted.
 */

import type { IDisposable, Terminal } from '@xterm/xterm';
import { CLIPBOARD_TEXT_MAX_CHARS } from '@protocol/clipboard';

/**
 * The OSC 52 clipboard targets: the clipboard selections and cut buffers.
 * Anything else (screen devices, other Ps) is not a clipboard write.
 */
const CLIPBOARD_TARGETS = new Set(['c', 's', 'p', 'q', '0', '1', '2', '7']);

/** The most base64 a clipboard payload at the text cap needs, with slack. */
const MAX_PAYLOAD_CHARS = Math.ceil((CLIPBOARD_TEXT_MAX_CHARS * 4) / 3) + 64;

/** The payload's UTF-8 text, or null when it is not text (images, garbage). */
function decodePayload(payload: string): string | null {
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  try {
    // Strict: an image or other binary payload decoded lossily would write
    // mojibake to the clipboard, so non-text simply never arrives.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // The same ceiling the relay carries; more than it is not clipboard text.
    return text.length <= CLIPBOARD_TEXT_MAX_CHARS ? text : null;
  } catch {
    return null;
  }
}

/**
 * Route OSC 52 clipboard writes in the terminal's output stream to
 * `onClipboardText`. Returns the parser registration to dispose with the
 * terminal.
 */
export function attachOsc52Clipboard(
  term: Terminal,
  onClipboardText: (text: string) => void,
): IDisposable {
  return term.parser.registerOscHandler(52, (data: string) => {
    const sep = data.indexOf(';');
    if (sep < 0) return true;
    const target = data.slice(0, sep) || 'c';
    const payload = data.slice(sep + 1);
    if (!CLIPBOARD_TARGETS.has(target)) return true;
    if (payload === '?') return true;
    const text = decodePayload(payload);
    if (text !== null) onClipboardText(text);
    return true;
  });
}
