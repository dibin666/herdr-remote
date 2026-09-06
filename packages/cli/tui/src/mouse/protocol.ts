// SGR mouse reporting: parsing and the escape sequences that turn it on.
//
// Written here rather than taken from a library because the available ones get
// the hit test wrong: `@ink-tools/ink-mouse` compares a click against inclusive
// bounds (`y >= top && y <= bottom`) while its rectangles are half-open, so a
// one-row item at row N also swallows clicks on row N+1 and two neighbouring
// rows both fire. In a vertical menu that reads as "the mouse selects the wrong
// entry".

const ESC = String.fromCharCode(27);

/** Any-motion tracking (1003) so hover works without a button held, plus SGR
 * coordinates (1006) so columns past 223 still report correctly. */
export const ENABLE_MOUSE = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`;
export const DISABLE_MOUSE = `${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`;

export type MouseButton = 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'none';

export type MouseEvent = {
  type: 'press' | 'release' | 'move' | 'wheel';
  button: MouseButton;
  /** 1-based terminal column. */
  x: number;
  /** 1-based terminal row. */
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

// ESC [ < button ; column ; row (M|m)
const SGR_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
// The longest incomplete prefix worth holding on to; beyond this the input is
// not a mouse report and must be passed through rather than swallowed.
const MAX_PENDING = 32;

function decodeButton(code: number, isRelease: boolean): MouseButton {
  if (code & 64) return (code & 3) === 1 ? 'wheel-down' : 'wheel-up';
  if (isRelease) return 'none';
  switch (code & 3) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    default: return 'none';
  }
}

function couldBeMousePrefix(value: string): boolean {
  // Partial forms of "\x1b[<…" that may complete on the next chunk.
  return `${ESC}[<`.startsWith(value.slice(0, 3)) && value.length <= MAX_PENDING && /^\x1b(\[(<[\d;]*)?)?$/.test(value);
}

export type SplitResult = {
  /** Mouse reports found, in order. */
  events: MouseEvent[];
  /** Everything that was not a mouse report, to hand to the key parser. */
  passthrough: string;
  /** A trailing partial sequence to prepend to the next chunk. */
  pending: string;
};

/**
 * Separate mouse reports from ordinary key input.
 *
 * Ink's key parser knows nothing about mouse reports, so an unfiltered click
 * would reach `useInput` as a stray Escape and cancel whatever the user was
 * editing. Everything that is not a mouse report is passed through untouched.
 */
export function splitMouseInput(buffer: string): SplitResult {
  const events: MouseEvent[] = [];
  let passthrough = '';
  let index = 0;

  while (index < buffer.length) {
    const escapeAt = buffer.indexOf(ESC, index);
    if (escapeAt === -1) {
      passthrough += buffer.slice(index);
      return { events, passthrough, pending: '' };
    }
    passthrough += buffer.slice(index, escapeAt);

    const rest = buffer.slice(escapeAt);
    const match = SGR_PATTERN.exec(rest);
    if (match) {
      const code = Number(match[1]);
      const isRelease = match[4] === 'm';
      const isMotion = (code & 32) !== 0;
      const isWheel = (code & 64) !== 0;
      events.push({
        type: isWheel ? 'wheel' : isMotion ? 'move' : isRelease ? 'release' : 'press',
        button: decodeButton(code, isRelease),
        x: Number(match[2]),
        y: Number(match[3]),
        shift: (code & 4) !== 0,
        alt: (code & 8) !== 0,
        ctrl: (code & 16) !== 0,
      });
      index = escapeAt + match[0].length;
      continue;
    }

    if (couldBeMousePrefix(rest)) {
      // Hold the fragment back; the rest of the report is in the next chunk.
      return { events, passthrough, pending: rest };
    }

    // A real escape sequence (arrow key, etc.) — hand it to the key parser.
    passthrough += ESC;
    index = escapeAt + 1;
  }

  return { events, passthrough, pending: '' };
}

/** Stateful wrapper that carries a partial sequence across chunk boundaries. */
export function createMouseSplitter() {
  let pending = '';
  return (chunk: string): { events: MouseEvent[]; passthrough: string } => {
    const result = splitMouseInput(pending + chunk);
    pending = result.pending;
    return { events: result.events, passthrough: result.passthrough };
  };
}
