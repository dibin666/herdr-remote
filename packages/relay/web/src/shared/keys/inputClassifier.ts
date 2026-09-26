/**
 * Sorts what xterm hands to `onData` into the three things predictive echo
 * has to treat differently.
 *
 * Herdr turns on any-motion mouse reporting (?1003) and focus reporting
 * (?1004) for its whole screen, so every mouse move over the terminal and
 * every window focus change arrives through the same channel as keystrokes.
 * Treating those as input used to wipe every pending prediction whenever the
 * pointer twitched while the user typed.
 *
 * - `passive`: nothing the remote program sees as an edit — motion without a
 *   button, focus in/out, and the terminal's replies to queries.
 * - `pointer`: a click, drag or wheel, which can move a caret or open a menu.
 * - `keys`: everything else.
 */
export type InputClass = 'passive' | 'pointer' | 'keys';

const ESC = '\x1b';

const FOCUS_REPORT = /^\x1b\[[IO]/;
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]/;
const X10_MOUSE = /^\x1b\[M[\s\S]{3}/;
const TERMINAL_REPLIES: ReadonlyArray<RegExp> = [
  /^\x1b\[\?[\d;]*c/, // primary DA
  /^\x1b\[>[\d;]*c/, // secondary DA
  /^\x1b\[\d+;\d+R/, // cursor position report
  /^\x1b\[\?\d+;\d+R/, // DECXCPR
  /^\x1b\[\d+n/, // device status
  /^\x1b\[\?[\d;]*\$y/, // DECRQM
  /^\x1b\[[\d;]*t/, // window reports
  /^\x1b\[\?\d+u/, // kitty keyboard flags
  /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC reply (colour queries)
  /^\x1bP[\s\S]*?\x1b\\/, // DCS reply
];

/** A modified F3 is `ESC[1;<mod>R`, which is shaped exactly like a cursor report. */
const MODIFIED_F3 = /^\x1b\[1;[2-8]R/;

function matchPassive(data: string): number {
  if (MODIFIED_F3.test(data)) return 0;
  const focus = FOCUS_REPORT.exec(data);
  if (focus) return focus[0].length;
  const sgr = SGR_MOUSE.exec(data);
  if (sgr) {
    const button = Number(sgr[1]);
    // Motion (bit 5) with "no button" (low bits 3) and not a wheel (bit 6).
    const isHover = (button & 32) !== 0 && (button & 3) === 3 && (button & 64) === 0;
    return isHover ? sgr[0].length : 0;
  }
  for (const reply of TERMINAL_REPLIES) {
    const match = reply.exec(data);
    if (match) return match[0].length;
  }
  return 0;
}

export function classifyInput(data: string): InputClass {
  if (!data.startsWith(ESC)) return 'keys';
  if (SGR_MOUSE.test(data) || X10_MOUSE.test(data)) {
    // A burst of motion reports is still passive; anything else is a pointer.
    let rest = data;
    while (rest.length > 0) {
      const length = matchPassive(rest);
      if (length === 0) return 'pointer';
      rest = rest.slice(length);
    }
    return 'passive';
  }
  let rest = data;
  while (rest.length > 0) {
    const length = matchPassive(rest);
    if (length === 0) return 'keys';
    rest = rest.slice(length);
  }
  return 'passive';
}

/** A bare Escape key, which in vim-style editors leaves insert mode. */
export function isLoneEscape(data: string): boolean {
  return data === ESC;
}
