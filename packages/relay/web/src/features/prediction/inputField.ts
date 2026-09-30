/**
 * Finds the text input field the cursor is in, if any.
 *
 * Prediction requires an identified editable field. Echoes alone cannot tell
 * an input box from output text or menu labels, so unknown layouts stay off.
 *
 * Herdr composites every pane onto one screen, so none of the usual terminal
 * signals (alternate screen, mouse or keypad modes) describe the pane: they
 * are Herdr's own. What it does forward is the focused pane's cursor. The
 * rules below were fitted to screens captured from Herdr 0.9.3 by
 * `scripts/capture-herdr-screens.mjs` (fixtures in `test/fixtures/screens`):
 *
 * - Claude Code draws its input between two full-width `─` rules, prompt `❯ `
 *   (or `! ` in shell mode), continuation rows indented by two. Herdr hides
 *   the outer cursor while Claude is focused, but still parks it on Claude's
 *   caret, so a hidden cursor inside such a box is trusted. The box grows
 *   upwards, so its bottom rule is the stable anchor. In vim mode the status
 *   rows below read `-- INSERT --`, and normal mode shows nothing at all.
 * - pi draws a rounded frame `╭─╮ │ │ ╰─╯` a few rows tall, cursor visible.
 * - fish and Codex are a single prompt line: a terminator glyph and a space
 *   before a visible cursor. On a phone-width screen fish's prompt fills its
 *   row and the command continues at the start of the next one. Codex wraps
 *   its text by words onto rows indented by two, and keeps the last cell of
 *   each row for its caret: a word that reaches the cell before it stays
 *   there, the caret moves to the next row, and the next key of that word
 *   moves the whole word down.
 * - Any Herdr overlay (help, pickers) dims everything behind it, and parks
 *   the hidden cursor wherever the pane had it — so a dimmed prompt glyph
 *   means the keys are going to the overlay, not the field.
 *
 * The screen interfaces (see `fieldScreen.ts`) are structural subsets of
 * xterm's buffer API, so the detector can run against captured fixtures.
 */

import {
  AGENT_PROMPTS,
  BOTTOM_LEFT,
  BOTTOM_RIGHT,
  CORNER_OR_JUNCTION_CHARS,
  EDGE_CHARS,
  type FieldCursor,
  type FieldScreen,
  isBlank,
  PANE_TOP_LEFT,
  PROMPT_TERMINATORS,
  RULE_CHARS,
  ScreenReader,
  type Segment,
  segmentAt,
  TOP_LEFT,
  TOP_RIGHT,
} from './fieldScreen';

type InputFieldKind = 'rule' | 'frame' | 'prompt';

export interface InputField {
  kind: InputFieldKind;
  /**
   * Identity of the field; confidence earned in one field is not lent to
   * another. It names the pane and the kind of field, never the rows the
   * field happens to occupy: a shell's next prompt line, or Claude's box
   * moving as its status area grows, is still the same field.
   */
  key: string;
  /** Identity of the pane-sized region the field lives in. */
  region: string;
  /**
   * Where the field's first row is. It changes when a box grows as its
   * text wraps, which shifts every row of text already typed.
   */
  layout: string;
  /** Absolute row and column of the caret. */
  row: number;
  caretCol: number;
  /** First editable column on the caret row. */
  startCol: number;
  /** One past the last column text can occupy on the caret row. */
  endCol: number;
  /** Nothing typed yet: the caret is at the start and only placeholder follows. */
  empty: boolean;
  /**
   * Agents that type their first key as a mode switch rather than text
   * (`?` for help, `!` for shell mode) are marked so the predictor can hold
   * back on an empty field.
   */
  agentLike: boolean;
  /** `true`/`false` when a vim-style mode line was checked, `null` when there is none to check. */
  vimInsert: boolean | null;
  /** The field is in vim insert mode, where a lone Escape turns keys into commands. */
  modal: boolean;
  /**
   * The caret starts a row that the word ending the row above runs on into:
   * Codex wraps by words, so the next key may move that word down.
   */
  midWord: boolean;
}

/** Taller than this, a frame is a pane border rather than an input box. */
const MAX_INPUT_ROWS = 8;
/**
 * How far below an agent box its mode and hint lines may reach. Claude's
 * status area grows while it works (tool counts, subagents, changed files):
 * seven rows were seen with `-- INSERT --` on the last.
 */
const STATUS_ROWS = 12;
/** Claude indents continuation rows under the prompt glyph and its space. */
const CONTINUATION_INDENT = 2;
/** pi pads its frame with one blank cell on each side. */
const FRAME_PAD = 1;
/** A prompt line wrapped onto the next row only when its terminator sat this close to the edge. */
const WRAP_SLACK = 4;
/** Rows a wrapped command may span below its prompt before we give up. */
const MAX_WRAPPED_ROWS = 3;
/** Rows of an agent's wrapped prompt text searched for the prompt glyph that starts it. */
const MAX_CONTINUATION_ROWS = 20;

const VIM_INSERT = /-- INSERT --/;
const VIM_OTHER_MODE = /-- (?:NORMAL|VISUAL(?: LINE| BLOCK)?|REPLACE) --/;
const MENU_HINT =
  /Esc to cancel|Enter to (?:confirm|select)|to navigate|Space to (?:change|toggle|select)/i;
const NUMBERED_CHOICE = /^\s*\d+[.)]\s/;

/**
 * A full-width rule of the segment. Herdr's pane top border is also a run of
 * `─` (with the agent's name in it); it starts from a corner, which a box
 * rule inside the pane never does.
 */
function isRuleRow(screen: ScreenReader, row: number, seg: Segment): boolean {
  if (
    !RULE_CHARS.has(screen.char(row, seg.start)) ||
    !RULE_CHARS.has(screen.char(row, seg.end - 1))
  )
    return false;
  if (CORNER_OR_JUNCTION_CHARS.has(screen.char(row, seg.start - 1))) return false;
  const width = seg.end - seg.start;
  let rules = 0;
  for (let col = seg.start; col < seg.end; col++) {
    if (RULE_CHARS.has(screen.char(row, col))) rules++;
    else if (col - seg.start - rules > width * 0.1) return false;
  }
  return rules >= width * 0.9;
}

function regionKey(seg: Segment): string {
  return `${seg.start}-${seg.end}`;
}

/**
 * The row of the top border of the pane a segment belongs to, or the top of
 * the screen when the pane has none. Panes stacked in one column band have
 * different tops, so their fields are told apart.
 */
function paneTop(screen: ScreenReader, row: number, seg: Segment): number {
  if (seg.start === 0) return screen.top;
  for (let y = row - 1; y >= screen.top; y--) {
    if (PANE_TOP_LEFT.has(screen.char(y, seg.start - 1))) return y;
  }
  return screen.top;
}

function detectFrame(screen: ScreenReader, cursor: FieldCursor, seg: Segment): InputField | null {
  const left = seg.start - 1;
  const right = seg.end;
  const { row } = cursor;
  if (left < 0 || right >= screen.cols) return null;
  const side = screen.char(row, left);
  if (!EDGE_CHARS.has(side) || screen.char(row, right) !== side) return null;

  let top = row - 1;
  while (top >= screen.top && screen.char(top, left) === side) top--;
  let bottom = row + 1;
  while (bottom <= screen.bottom && screen.char(bottom, left) === side) bottom++;
  if (bottom - top - 1 > MAX_INPUT_ROWS) return null;
  if (!TOP_LEFT.has(screen.char(top, left)) || !TOP_RIGHT.has(screen.char(top, right))) return null;
  if (!BOTTOM_LEFT.has(screen.char(bottom, left)) || !BOTTOM_RIGHT.has(screen.char(bottom, right)))
    return null;
  if (screen.dim(row, left)) return null;

  const startCol = seg.start + FRAME_PAD;
  const endCol = seg.end - FRAME_PAD;
  if (cursor.col < startCol || cursor.col >= endCol) return null;
  return {
    kind: 'frame',
    key: `frame:${regionKey(seg)}`,
    region: regionKey(seg),
    layout: `${top}`,
    row,
    caretCol: cursor.col,
    startCol,
    endCol,
    empty:
      top + 2 === bottom && cursor.col === startCol && screen.blankOrDim(row, startCol, endCol),
    agentLike: true,
    vimInsert: null,
    modal: false,
    midWord: false,
  };
}

function detectRuleBox(screen: ScreenReader, cursor: FieldCursor, seg: Segment): InputField | null {
  const { row } = cursor;
  let topRule = -1;
  for (let y = row - 1; y >= Math.max(screen.top, row - MAX_INPUT_ROWS); y--) {
    if (isRuleRow(screen, y, seg)) {
      topRule = y;
      break;
    }
  }
  if (topRule < 0) return null;
  let bottomRule = -1;
  for (let y = row + 1; y <= Math.min(screen.bottom, row + MAX_INPUT_ROWS); y++) {
    if (isRuleRow(screen, y, seg)) {
      bottomRule = y;
      break;
    }
  }
  if (bottomRule < 0) return null;

  const firstRow = topRule + 1;
  let glyphCol = -1;
  for (let col = seg.start; col < Math.min(seg.end, seg.start + 3); col++) {
    const chars = screen.char(firstRow, col);
    if (isBlank(chars)) continue;
    if (AGENT_PROMPTS.has(chars) && isBlank(screen.char(firstRow, col + 1))) glyphCol = col;
    break;
  }
  if (glyphCol < 0) return null;
  // A dimmed prompt is under a Herdr overlay; the keys belong to the overlay.
  if (screen.dim(firstRow, glyphCol)) return null;
  if (NUMBERED_CHOICE.test(screen.text(firstRow, glyphCol + 1, seg.end))) return null;
  for (let y = firstRow + 1; y < bottomRule; y++) {
    for (let col = seg.start; col < seg.start + CONTINUATION_INDENT; col++) {
      if (!isBlank(screen.char(y, col))) return null;
    }
  }

  let status = '';
  for (let y = bottomRule + 1; y <= Math.min(screen.bottom, bottomRule + STATUS_ROWS); y++) {
    // A pane's bottom border ends this pane; what is below belongs to another.
    if (CORNER_OR_JUNCTION_CHARS.has(screen.char(y, seg.start - 1))) break;
    status += `${screen.text(y, seg.start, seg.end)}\n`;
  }
  if (MENU_HINT.test(status) || VIM_OTHER_MODE.test(status)) return null;

  const startCol = row === firstRow ? glyphCol + 2 : seg.start + CONTINUATION_INDENT;
  if (cursor.col < startCol || cursor.col >= seg.end) return null;
  return {
    kind: 'rule',
    key: `rule:${regionKey(seg)}:${paneTop(screen, topRule, seg)}`,
    region: regionKey(seg),
    layout: `${topRule}`,
    row,
    caretCol: cursor.col,
    startCol,
    endCol: seg.end,
    empty:
      bottomRule - topRule === 2 &&
      cursor.col === startCol &&
      screen.blankOrDim(row, startCol, seg.end),
    agentLike: true,
    vimInsert: VIM_INSERT.test(status),
    modal: VIM_INSERT.test(status),
    midWord: false,
  };
}

function detectPromptLine(
  screen: ScreenReader,
  cursor: FieldCursor,
  seg: Segment,
): InputField | null {
  // Only a visible cursor is trusted here: Herdr hides it while an overlay or
  // a program that paints its own caret has the keys.
  if (cursor.hidden) return null;
  const { row, col } = cursor;

  const continued = detectContinuation(screen, cursor, seg);
  if (continued !== undefined) return continued;

  // CMD's default prompt (`C:\path>`) has no space after its terminator.
  // Accept it only when the text before `>` is itself a Windows prompt path;
  // a redirection operator in an ordinary command is not an input boundary.
  for (let x = col - 1; x >= seg.start; x--) {
    if (screen.char(row, x) !== '>') continue;
    const prompt = screen.text(row, seg.start, x + 1).trimStart();
    if (/^(?:[a-z]:\\.*|\\\\[^\\]+\\[^\\]+.*|PS\s+[a-z]:\\.*)>$/i.test(prompt)) {
      return promptField(screen, cursor, seg, row, x + 1, false);
    }
  }

  // The rightmost terminator is used so that a `>` typed into the command
  // itself can only make the field look shorter, never swallow the prompt.
  for (let x = col - 2; x >= seg.start; x--) {
    if (!PROMPT_TERMINATORS.has(screen.char(row, x)) || !isBlank(screen.char(row, x + 1))) continue;
    if (screen.dim(row, x)) return null;
    return promptField(screen, cursor, seg, row, x + 2, x === seg.start);
  }

  // A prompt that fills its row pushes the command onto the next one.
  for (
    let promptRow = row - 1;
    promptRow >= Math.max(screen.top, row - MAX_WRAPPED_ROWS);
    promptRow--
  ) {
    let last = seg.end - 1;
    while (last >= seg.start && isBlank(screen.char(promptRow, last))) last--;
    if (last >= seg.end - 1 - WRAP_SLACK && PROMPT_TERMINATORS.has(screen.char(promptRow, last))) {
      if (screen.dim(promptRow, last)) return null;
      return promptField(screen, cursor, seg, promptRow, seg.start, false);
    }
    // A row in between must be command text that ran into the edge.
    if (last < seg.end - 1) return null;
  }
  return null;
}

/**
 * A row of an agent's prompt text wrapped under its glyph (Codex): indented
 * by two, below rows of text indented the same way, below the row the glyph
 * starts. Undefined when the caret row is not shaped like one.
 */
function detectContinuation(
  screen: ScreenReader,
  cursor: FieldCursor,
  seg: Segment,
): InputField | null | undefined {
  const { row } = cursor;
  const indent = seg.start + CONTINUATION_INDENT;
  const indented = (y: number) =>
    isBlank(screen.char(y, seg.start)) && isBlank(screen.char(y, seg.start + 1));
  if (!indented(row)) return undefined;
  for (let y = row - 1; y >= Math.max(screen.top, row - MAX_CONTINUATION_ROWS); y--) {
    if (AGENT_PROMPTS.has(screen.char(y, seg.start)) && isBlank(screen.char(y, seg.start + 1))) {
      if (screen.dim(y, seg.start)) return null;
      return promptField(screen, cursor, seg, y, indent, true, indent);
    }
    if (!indented(y) || screen.blankOrDim(y, indent, seg.end)) return undefined;
  }
  return undefined;
}

function promptField(
  screen: ScreenReader,
  cursor: FieldCursor,
  seg: Segment,
  promptRow: number,
  promptEnd: number,
  bareGlyph: boolean,
  continuationStart = seg.start,
): InputField | null {
  const startCol = cursor.row === promptRow ? promptEnd : continuationStart;
  if (cursor.col < startCol || cursor.col >= seg.end) return null;
  const lastTextCol = seg.end - 2;
  const midWord =
    cursor.row > promptRow &&
    continuationStart > seg.start &&
    cursor.col === startCol &&
    !isBlank(screen.char(cursor.row - 1, lastTextCol));
  return {
    kind: 'prompt',
    key: `prompt:${regionKey(seg)}:${paneTop(screen, promptRow, seg)}`,
    region: regionKey(seg),
    layout: `${promptRow}`,
    row: cursor.row,
    caretCol: cursor.col,
    startCol,
    endCol: seg.end,
    empty:
      cursor.row === promptRow &&
      cursor.col === startCol &&
      screen.blankOrDim(cursor.row, startCol, seg.end),
    // A prompt that is nothing but a glyph (`› `) is an agent's, not a shell's.
    agentLike: bareGlyph,
    vimInsert: null,
    modal: false,
    midWord,
  };
}

export function detectInputField(screen: FieldScreen, cursor: FieldCursor): InputField | null {
  const reader = new ScreenReader(screen);
  if (
    cursor.row < reader.top ||
    cursor.row > reader.bottom ||
    cursor.col < 0 ||
    cursor.col >= screen.cols
  ) {
    return null;
  }
  const seg = segmentAt(reader, cursor.row, cursor.col);
  if (!seg) return null;
  return (
    detectFrame(reader, cursor, seg) ??
    detectRuleBox(reader, cursor, seg) ??
    detectPromptLine(reader, cursor, seg)
  );
}

/**
 * Wraps the detector with the one thing it cannot see on a single screen:
 * Claude's vim normal mode. Insert mode prints `-- INSERT --` under the box,
 * normal mode prints nothing, which looks exactly like vim mode being off. So
 * once a region has shown the insert marker, its absence there means normal
 * mode, where keys are commands and nothing may be predicted.
 */
export class InputFieldTracker {
  private readonly insertSeen = new Set<string>();

  detect(screen: FieldScreen, cursor: FieldCursor): InputField | null {
    const field = detectInputField(screen, cursor);
    if (!field || field.vimInsert === null) return field;
    if (field.vimInsert) {
      this.insertSeen.add(field.region);
      return field;
    }
    return this.insertSeen.has(field.region) ? null : field;
  }

  reset(): void {
    this.insertSeen.clear();
  }
}

export interface FieldProbeOptions {
  getScreen: () => FieldScreen | null;
  getCursor: () => FieldCursor | null;
  /** True while a frame is half drawn; the last complete frame is used instead. */
  isSynchronizing?: () => boolean;
}

/**
 * The detector as the predictor uses it: at most one scan per parsed write,
 * and never a scan of a frame Herdr has only half drawn.
 */
export class FieldProbe {
  private readonly tracker = new InputFieldTracker();
  private cached: InputField | null | undefined;
  private lastComplete: InputField | null = null;

  constructor(private readonly options: FieldProbeOptions) {}

  readonly detect = (): InputField | null => {
    if (this.options.isSynchronizing?.()) return this.lastComplete;
    if (this.cached === undefined) {
      const screen = this.options.getScreen();
      const cursor = this.options.getCursor();
      this.cached = screen && cursor ? this.tracker.detect(screen, cursor) : null;
      this.lastComplete = this.cached;
    }
    return this.cached;
  };

  /** The screen changed; the next `detect` scans again. */
  invalidate(): void {
    this.cached = undefined;
  }

  reset(): void {
    this.tracker.reset();
    this.cached = undefined;
    this.lastComplete = null;
  }
}
