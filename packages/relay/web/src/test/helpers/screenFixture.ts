import fs from 'fs';
import path from 'path';
import type { FieldCell, FieldLine, FieldScreen } from '@/features/prediction/fieldScreen';
import { predictableWidth } from '@/features/prediction/wideChars';

/**
 * Rebuilds a cell grid from a screen captured by
 * `scripts/capture-herdr-screens.mjs`, shaped like the slice of xterm's buffer
 * API that the input-field detector and the predictor read.
 */
export interface ScreenFixture {
  name: string;
  source: { layout: string; cols: number; rows: number };
  cursor: { x: number; y: number; hidden: boolean; style: string };
  lines: string[];
  wide: Array<[number, number]>;
  attrs: Array<{
    row: number;
    col: number;
    len: number;
    inverse: number;
    dim: number;
    bg: number | null;
  }>;
}

interface Cell {
  chars: string;
  width: number;
  dim: boolean;
}

/** A cell as both the detector and the predictor read it. */
export interface TestCell extends FieldCell {
  getWidth(): number;
}

export interface TestLine extends FieldLine {
  getCell(x: number, cell?: FieldCell): TestCell | undefined;
}

export interface TestScreen extends FieldScreen {
  getLine(row: number): TestLine | undefined;
  cursor: { row: number; col: number; hidden: boolean };
  buffer: {
    active: {
      baseY: number;
      cursorX: number;
      cursorY: number;
      getLine(row: number): TestLine | undefined;
      getNullCell(): TestCell;
    };
  };
  setCell(row: number, col: number, cell: Partial<Cell>): void;
  /** Writes text the way a terminal would: wide characters take two cells. */
  write(row: number, col: number, text: string, options?: { dim?: boolean }): void;
  setCursor(col: number, row: number, hidden?: boolean): void;
  rowText(row: number): string;
}

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/screens');

export function loadScreenFixture(name: string): ScreenFixture {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'),
  ) as ScreenFixture;
}

export function listScreenFixtures(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

/** Marks that attach to the previous cell rather than taking one of their own. */
function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  );
}

export function createTestScreen(cols: number, rows: number): TestScreen {
  const blank = (): Cell => ({ chars: '', width: 1, dim: false });
  const grid: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, blank));
  const cursor = { row: 0, col: 0, hidden: false };

  const view = (cell: Cell): TestCell => ({
    getChars: () => cell.chars,
    getWidth: () => cell.width,
    isDim: () => (cell.dim ? 1 : 0),
  });

  const getLine = (row: number): TestLine | undefined => {
    const cells = grid[row];
    if (!cells) return undefined;
    return {
      getCell: (x: number) => (x >= 0 && x < cols ? view(cells[x]) : undefined),
      translateToString: (trimRight = false, start = 0, end = cols) => {
        let text = '';
        for (let x = start; x < end; x++) {
          if (cells[x].width === 0) continue;
          text += cells[x].chars || ' ';
        }
        return trimRight ? text.replace(/\s+$/, '') : text;
      },
    };
  };

  const setCell = (row: number, col: number, cell: Partial<Cell>) => {
    if (!grid[row] || col < 0 || col >= cols) return;
    grid[row][col] = { ...grid[row][col], ...cell };
  };

  const write = (row: number, col: number, text: string, options: { dim?: boolean } = {}) => {
    let x = col;
    for (const ch of text) {
      const codePoint = ch.codePointAt(0) ?? 0;
      if (isCombining(codePoint) && x > 0) {
        grid[row][x - 1].chars += ch;
        continue;
      }
      if (x >= cols) break;
      const width = predictableWidth(codePoint) === 2 ? 2 : 1;
      setCell(row, x, { chars: ch, width, dim: Boolean(options.dim) });
      if (width === 2) setCell(row, x + 1, { chars: '', width: 0, dim: Boolean(options.dim) });
      x += width;
    }
  };

  return {
    cols,
    rows,
    baseY: 0,
    getLine,
    getNullCell: () => view(blank()),
    cursor,
    buffer: {
      active: {
        baseY: 0,
        get cursorX() {
          return cursor.col;
        },
        get cursorY() {
          return cursor.row;
        },
        getLine,
        getNullCell: () => view(blank()),
      },
    },
    setCell,
    write,
    setCursor(col: number, row: number, hidden = cursor.hidden) {
      cursor.col = col;
      cursor.row = row;
      cursor.hidden = hidden;
    },
    rowText: (row: number) => getLine(row)?.translateToString(true) ?? '',
  };
}

export function screenFromFixture(fixture: ScreenFixture): TestScreen {
  const { cols, rows } = fixture.source;
  const screen = createTestScreen(cols, rows);
  // The capture recorded which cells xterm made wide; trust that over the table.
  const wide = new Set(fixture.wide.map(([row, col]) => `${row}:${col}`));
  fixture.lines.forEach((line, row) => {
    let x = 0;
    let previous = -1;
    for (const ch of line) {
      const codePoint = ch.codePointAt(0) ?? 0;
      if (isCombining(codePoint) && previous >= 0) {
        screen.setCell(row, previous, {
          chars: `${screen.getLine(row)!.getCell(previous)!.getChars()}${ch}`,
        });
        continue;
      }
      if (x >= cols) break;
      const width = wide.has(`${row}:${x}`) ? 2 : 1;
      screen.setCell(row, x, { chars: ch === ' ' ? '' : ch, width });
      if (width === 2) screen.setCell(row, x + 1, { chars: '', width: 0 });
      previous = x;
      x += width;
    }
  });
  for (const run of fixture.attrs) {
    if (!run.dim) continue;
    for (let col = run.col; col < run.col + run.len; col++)
      screen.setCell(run.row, col, { dim: true });
  }
  screen.setCursor(fixture.cursor.x, fixture.cursor.y, fixture.cursor.hidden);
  return screen;
}
