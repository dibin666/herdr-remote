/**
 * Reading Herdr's composited screen cell by cell: the structural subset of
 * xterm's buffer API the field detector needs (so it also runs against
 * captured fixtures), the box-drawing glyphs that make up borders and
 * prompts, and the run of the caret row between the nearest borders.
 */

export interface FieldCell {
  getChars(): string;
  isDim?(): number;
}

export interface FieldLine {
  getCell(x: number, cell?: FieldCell): FieldCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface FieldScreen {
  cols: number;
  rows: number;
  /** Absolute row of the top of the screen; the cursor row is relative to it. */
  baseY: number;
  getLine(row: number): FieldLine | undefined;
  getNullCell?(): FieldCell;
}

export interface FieldCursor {
  /** Absolute row. */
  row: number;
  col: number;
  hidden: boolean;
}

/** Vertical strokes that form pane borders, box sides and Herdr's scrollbar. */
export const EDGE_CHARS = new Set(['│', '┃', '║', '▐', '▕', '▏', '▌']);
export const CORNER_OR_JUNCTION_CHARS = new Set([
  '┌',
  '┐',
  '└',
  '┘',
  '╭',
  '╮',
  '╰',
  '╯',
  '├',
  '┤',
  '┬',
  '┴',
  '┼',
  '┏',
  '┓',
  '┗',
  '┛',
  '╔',
  '╗',
  '╚',
  '╝',
  '╠',
  '╣',
  '╟',
  '╢',
  '╞',
  '╡',
]);
export const TOP_LEFT = new Set(['╭', '┌', '┏', '╔']);
/** Where a pane's left border starts: its top corner, or a junction with the pane above. */
export const PANE_TOP_LEFT = new Set([
  '╭',
  '┌',
  '┏',
  '╔',
  '├',
  '┣',
  '┠',
  '┝',
  '╟',
  '╠',
  '┞',
  '┟',
  '┡',
  '┢',
]);
export const TOP_RIGHT = new Set(['╮', '┐', '┓', '╗']);
export const BOTTOM_LEFT = new Set(['╰', '└', '┗', '╚']);
export const BOTTOM_RIGHT = new Set(['╯', '┘', '┛', '╝']);
export const RULE_CHARS = new Set(['─', '━', '═', '╌', '┄']);
export const AGENT_PROMPTS = new Set(['❯', '›', '>', '!']);
export const PROMPT_TERMINATORS = new Set(['$', '#', '%', '>', '❯', '›', '➜', 'λ', '»']);

export function isBlank(chars: string): boolean {
  return chars === '' || chars === ' ' || chars === '\u00a0';
}

export class ScreenReader {
  private readonly cell: FieldCell | undefined;
  readonly top: number;
  readonly bottom: number;

  constructor(private readonly screen: FieldScreen) {
    this.cell = screen.getNullCell?.();
    this.top = screen.baseY;
    this.bottom = screen.baseY + screen.rows - 1;
  }

  get cols(): number {
    return this.screen.cols;
  }

  at(row: number, col: number): FieldCell | undefined {
    if (row < this.top || row > this.bottom || col < 0 || col >= this.screen.cols) return undefined;
    return this.screen.getLine(row)?.getCell(col, this.cell);
  }

  char(row: number, col: number): string {
    return this.at(row, col)?.getChars() ?? '';
  }

  dim(row: number, col: number): boolean {
    return Boolean(this.at(row, col)?.isDim?.());
  }

  text(row: number, start: number, end: number): string {
    if (row < this.top || row > this.bottom) return '';
    return this.screen.getLine(row)?.translateToString(true, start, end) ?? '';
  }

  /** A stroke only counts as a border if the stroke continues above or below it. */
  isEdge(row: number, col: number): boolean {
    if (!EDGE_CHARS.has(this.char(row, col))) return false;
    const above = this.char(row - 1, col);
    const below = this.char(row + 1, col);
    return (
      EDGE_CHARS.has(above) ||
      CORNER_OR_JUNCTION_CHARS.has(above) ||
      EDGE_CHARS.has(below) ||
      CORNER_OR_JUNCTION_CHARS.has(below)
    );
  }

  /** Blank from `start` to `end`, ignoring dimmed placeholder text. */
  blankOrDim(row: number, start: number, end: number): boolean {
    for (let col = start; col < end; col++) {
      const cell = this.at(row, col);
      if (cell && !isBlank(cell.getChars()) && !cell.isDim?.()) return false;
    }
    return true;
  }
}

export interface Segment {
  start: number;
  end: number;
}

/** The horizontal run of the caret row between the nearest borders around the caret. */
export function segmentAt(screen: ScreenReader, row: number, col: number): Segment | null {
  if (screen.isEdge(row, col)) return null;
  let start = 0;
  for (let x = col - 1; x >= 0; x--) {
    if (screen.isEdge(row, x)) {
      start = x + 1;
      break;
    }
  }
  let end = screen.cols;
  for (let x = col + 1; x < screen.cols; x++) {
    if (screen.isEdge(row, x)) {
      end = x;
      break;
    }
  }
  return start < end ? { start, end } : null;
}
