import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  pointToCell,
  wordRangeAt,
  lineRangeAt,
  screenText,
  scrollbackText,
  DEFAULT_WORD_SEPARATORS,
  paneColumnBand,
  clampRectToBand,
  rectText,
  VERTICAL_BORDER_CHARS,
  PANE_DIVIDER_THRESHOLD,
} from '../utils/terminalSelection';

/**
 * Creates a mock terminal cell.
 */
function createMockCell(char: string, width: number) {
  return {
    getChars: () => char,
    getWidth: () => width,
    getCode: () => (char ? char.charCodeAt(0) : 0),
  };
}

/**
 * Creates a mock IBufferLine accurately modelling wide characters (CJK) and continuation cells.
 *
 * Wide characters like Hanzi occupy 2 columns:
 *   - The leading cell reports char = '中', width = 2.
 *   - The trailing cell immediately following reports char = '', width = 0.
 */
function createMockBufferLine(
  textWithWidths: Array<{ char: string; width: number }>,
  lineLength: number
) {
  return {
    isWrapped: false,
    length: lineLength,
    getCell(x: number) {
      if (x < 0 || x >= textWithWidths.length) {
        return undefined;
      }
      const item = textWithWidths[x];
      return createMockCell(item.char, item.width);
    },
    translateToString(trimRight = false, startCol = 0, endCol = lineLength) {
      const start = Math.max(0, startCol);
      const end = Math.min(lineLength, endCol);
      let str = '';
      let c = start;
      while (c < end) {
        if (c >= textWithWidths.length) {
          str += ' ';
          c++;
          continue;
        }
        const item = textWithWidths[c];
        str += item.char;
        c += Math.max(1, item.width);
      }
      if (trimRight) {
        str = str.replace(/\s+$/, '');
      }
      return str;
    },
  };
}

/**
 * Helper to build a terminal grid row from a string containing ASCII and CJK characters.
 * Automatically inserts width: 0 continuation cells after width: 2 CJK ideographs.
 */
function buildTerminalLine(text: string, totalCols = 80) {
  const cells: Array<{ char: string; width: number }> = [];

  for (const ch of text) {
    // Check if CJK full-width character range
    const isCJK = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60]/.test(ch);
    if (isCJK) {
      cells.push({ char: ch, width: 2 });
      cells.push({ char: '', width: 0 }); // Continuation cell
    } else {
      cells.push({ char: ch, width: 1 });
    }
  }

  // Pad remaining columns up to totalCols with empty width: 1 cells
  while (cells.length < totalCols) {
    cells.push({ char: '', width: 1 });
  }

  return createMockBufferLine(cells, totalCols);
}

describe('terminalSelection utils', () => {
  describe('pointToCell', () => {
    function createMockTerm(cols = 80, rows = 24, viewportY = 0) {
      return {
        cols,
        rows,
        buffer: {
          active: {
            viewportY,
            length: 100,
          },
        },
        _core: {
          _renderService: {
            dimensions: {
              css: {
                cell: { width: 9, height: 18 },
              },
            },
          },
        },
      } as unknown as Terminal;
    }

    function createMockScreenEl(left = 10, top = 20, width = 720, height = 432) {
      return {
        getBoundingClientRect: () => ({
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
        }),
      } as unknown as HTMLElement;
    }

    it('maps client coordinates to 0-based column and visible row', () => {
      const term = createMockTerm(80, 24, 0);
      const screenEl = createMockScreenEl(10, 20);

      // Hit col 5, row 2:
      // x = 10 + 5 * 9 + 4 = 59
      // y = 20 + 2 * 18 + 5 = 61
      const result = pointToCell({ clientX: 59, clientY: 61 }, term, screenEl);
      expect(result).toEqual({ col: 5, bufferRow: 2 });
    });

    it('adds viewportY to visible row to produce absolute buffer row', () => {
      // Scrolled 15 rows into scrollback
      const term = createMockTerm(80, 24, 15);
      const screenEl = createMockScreenEl(10, 20);

      const result = pointToCell({ clientX: 59, clientY: 61 }, term, screenEl);
      // visible row is 2, absolute bufferRow should be 15 + 2 = 17
      expect(result).toEqual({ col: 5, bufferRow: 17 });
    });

    it('clamps coordinates exceeding terminal bounds', () => {
      const term = createMockTerm(80, 24, 0);
      const screenEl = createMockScreenEl(10, 20, 720, 432);

      // Negative coordinates (outside top-left)
      const topResult = pointToCell({ clientX: -50, clientY: -100 }, term, screenEl);
      expect(topResult).toEqual({ col: 0, bufferRow: 0 });

      // Out of bounds coordinates (past bottom-right)
      const botResult = pointToCell({ clientX: 1000, clientY: 1000 }, term, screenEl);
      expect(botResult).toEqual({ col: 79, bufferRow: 23 });
    });

    it('compensates for scale via screenToLogicalCoords', () => {
      const term = createMockTerm(80, 24, 0);
      const screenEl = createMockScreenEl(10, 20, 720, 432);

      // Scale 2.0: touch at screenX = 10 + (5 * 9) * 2 = 100, screenY = 20 + (3 * 18) * 2 = 128
      const result = pointToCell({ clientX: 100, clientY: 128 }, term, screenEl, 2.0);
      expect(result).toEqual({ col: 5, bufferRow: 3 });
    });

    it('returns null if screen element is missing or not measurable', () => {
      const term = createMockTerm(80, 24, 0);
      const result = pointToCell({ clientX: 10, clientY: 10 }, term, null);
      expect(result).toBeNull();
    });
  });

  describe('wordRangeAt', () => {
    it('selects simple ASCII words and handles boundaries', () => {
      const line = buildTerminalLine('git status -s', 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      // "git" is cols 0..2 (length: 3)
      expect(wordRangeAt(term, 0, 0)).toEqual({ startCol: 0, length: 3 });
      expect(wordRangeAt(term, 1, 0)).toEqual({ startCol: 0, length: 3 });
      expect(wordRangeAt(term, 2, 0)).toEqual({ startCol: 0, length: 3 });

      // Column 3 is a space -> separator -> null
      expect(wordRangeAt(term, 3, 0)).toBeNull();

      // "status" is cols 4..9 (length: 6)
      expect(wordRangeAt(term, 4, 0)).toEqual({ startCol: 4, length: 6 });
      expect(wordRangeAt(term, 9, 0)).toEqual({ startCol: 4, length: 6 });

      // Column 10 is space -> null
      expect(wordRangeAt(term, 10, 0)).toBeNull();

      // "-s" is cols 11..12 (length: 2)
      expect(wordRangeAt(term, 11, 0)).toEqual({ startCol: 11, length: 2 });
    });

    it('includes path and URL symbols (/ . _ -) in selected word for touch convenience', () => {
      const line = buildTerminalLine('open /usr/local/bin/herdr_relay.js now', 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      // Path begins at col 5 ('/') and ends at col 33 ('s'), length = 29
      const result = wordRangeAt(term, 10, 0); // Tap inside "/usr/local..."
      expect(result).toEqual({ startCol: 5, length: 29 });
    });

    it('correctly calculates column range for CJK double-width characters', () => {
      // "git 提交 成功 -m 'feat'"
      // Layout:
      // 'g','i','t'       -> cols 0, 1, 2 (width 1 each)
      // ' '               -> col 3 (width 1, sep)
      // '提'              -> col 4 (width 2), col 5 (continuation, width 0)
      // '交'              -> col 6 (width 2), col 7 (continuation, width 0)
      // ' '               -> col 8 (width 1, sep)
      // '成'              -> col 9 (width 2), col 10 (width 0)
      // '功'              -> col 11 (width 2), col 12 (width 0)
      const line = buildTerminalLine("git 提交 成功 -m 'feat'", 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      // 1. Tapping on the leading cell of '提' (col 4)
      expect(wordRangeAt(term, 4, 0)).toEqual({ startCol: 4, length: 4 });

      // 2. Tapping on the continuation cell of '提' (col 5)
      expect(wordRangeAt(term, 5, 0)).toEqual({ startCol: 4, length: 4 });

      // 3. Tapping on the leading cell of '交' (col 6)
      expect(wordRangeAt(term, 6, 0)).toEqual({ startCol: 4, length: 4 });

      // 4. Tapping on the continuation cell of '交' (col 7)
      expect(wordRangeAt(term, 7, 0)).toEqual({ startCol: 4, length: 4 });

      // 5. Tapping on the whitespace in between (col 8) yields null
      expect(wordRangeAt(term, 8, 0)).toBeNull();

      // 6. Tapping on '成' (col 9) or '功' (col 12) selects "成功"
      expect(wordRangeAt(term, 9, 0)).toEqual({ startCol: 9, length: 4 });
      expect(wordRangeAt(term, 12, 0)).toEqual({ startCol: 9, length: 4 });
    });

    it('CRITICAL: prevents column drift when CJK wide characters are mixed with ASCII in a filename', () => {
      // Text: "cat herdr-日志-2025.log"
      // Detailed column layout:
      // 'c','a','t'              -> cols 0..2 (3 cols)
      // ' '                      -> col 3 (1 col, separator)
      // 'h','e','r','d','r','-'  -> cols 4..9 (6 cols)
      // '日' (width: 2)          -> cols 10, 11 (2 cols)
      // '志' (width: 2)          -> cols 12, 13 (2 cols)
      // '-','2','0','2','5','.','l','o','g' -> cols 14..22 (9 cols)
      // Total column span for "herdr-日志-2025.log" = 6 + 2 + 2 + 9 = 19 columns!
      // In contrast, string character count is: 6 + 1 + 1 + 9 = 17 characters.
      // If code mistakenly used string index length, it would return length: 17,
      // which would clip off the last 2 characters (".og") in the terminal selection!
      const line = buildTerminalLine('cat herdr-日志-2025.log', 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      // Tap on ASCII prefix 'h' (col 4)
      expect(wordRangeAt(term, 4, 0)).toEqual({ startCol: 4, length: 19 });

      // Tap on Chinese character '日' leading cell (col 10)
      expect(wordRangeAt(term, 10, 0)).toEqual({ startCol: 4, length: 19 });

      // Tap on Chinese character '日' continuation cell (col 11)
      expect(wordRangeAt(term, 11, 0)).toEqual({ startCol: 4, length: 19 });

      // Tap on Chinese character '志' (col 12)
      expect(wordRangeAt(term, 12, 0)).toEqual({ startCol: 4, length: 19 });

      // Tap on ASCII suffix 'g' (col 22)
      expect(wordRangeAt(term, 22, 0)).toEqual({ startCol: 4, length: 19 });
    });

    it('returns null when tapping on empty trailing columns', () => {
      const line = buildTerminalLine('echo hi', 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      expect(wordRangeAt(term, 50, 0)).toBeNull();
    });

    it('respects custom wordSeparator options', () => {
      // Add ':' to word separators
      const line = buildTerminalLine('port:8080', 80);
      const term = {
        cols: 80,
        options: { wordSeparator: DEFAULT_WORD_SEPARATORS + ':' },
        buffer: {
          active: {
            getLine: (y: number) => (y === 0 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      // 'port' is cols 0..3 (length 4)
      expect(wordRangeAt(term, 1, 0)).toEqual({ startCol: 0, length: 4 });

      // ':' at col 4 is separator
      expect(wordRangeAt(term, 4, 0)).toBeNull();

      // '8080' is cols 5..8 (length 4)
      expect(wordRangeAt(term, 6, 0)).toEqual({ startCol: 5, length: 4 });
    });
  });

  describe('lineRangeAt', () => {
    it('returns column range spanning col 0 to line.length', () => {
      const line = buildTerminalLine('const x = 42;', 80);
      const term = {
        cols: 80,
        buffer: {
          active: {
            getLine: (y: number) => (y === 5 ? line : undefined),
          },
        },
      } as unknown as Terminal;

      expect(lineRangeAt(term, 5)).toEqual({ startCol: 0, length: 80 });
      expect(lineRangeAt(term, 99)).toBeNull();
    });
  });

  describe('screenText', () => {
    it('extracts visible lines from viewportY and trims trailing empty rows', () => {
      const line0 = buildTerminalLine('Line 1 output', 80);
      const line1 = buildTerminalLine('Line 2 output', 80);
      const line2 = buildTerminalLine('', 80);
      const line3 = buildTerminalLine('', 80);

      const term = {
        rows: 4,
        cols: 80,
        buffer: {
          active: {
            viewportY: 0,
            getLine: (y: number) => {
              if (y === 0) return line0;
              if (y === 1) return line1;
              if (y === 2) return line2;
              if (y === 3) return line3;
              return undefined;
            },
          },
        },
      } as unknown as Terminal;

      const text = screenText(term);
      expect(text).toBe('Line 1 output\nLine 2 output');
    });

    it('returns empty string if all visible rows are blank', () => {
      const line = buildTerminalLine('', 80);
      const term = {
        rows: 3,
        cols: 80,
        buffer: {
          active: {
            viewportY: 0,
            getLine: () => line,
          },
        },
      } as unknown as Terminal;

      expect(screenText(term)).toBe('');
    });
  });

  describe('scrollbackText', () => {
    it('extracts all lines from line 0 to buffer length and trims trailing empty rows', () => {
      const lines = [
        buildTerminalLine('First boot line', 80),
        buildTerminalLine('Middle scrollback', 80),
        buildTerminalLine('Recent output', 80),
        buildTerminalLine('', 80),
      ];

      const term = {
        rows: 2,
        cols: 80,
        buffer: {
          active: {
            length: lines.length,
            getLine: (y: number) => lines[y],
          },
        },
      } as unknown as Terminal;

      const text = scrollbackText(term);
      expect(text).toBe('First boot line\nMiddle scrollback\nRecent output');
    });
  });

  describe('paneColumnBand', () => {
    function createGridMockTerm(
      lines: ReturnType<typeof buildTerminalLine>[],
      cols = 80,
      viewportY = 0
    ) {
      return {
        cols,
        rows: lines.length,
        buffer: {
          active: {
            viewportY,
            length: lines.length,
            getLine: (y: number) => lines[y],
          },
        },
      } as unknown as Terminal;
    }

    /**
     * Helper to construct a mock line where column `dividerCol` contains a vertical bar
     * and other columns contain padding or content.
     */
    function makeDividedLine(leftText: string, dividerCol: number, rightText: string, dividerChar = '│', totalCols = 80) {
      const cells: Array<{ char: string; width: number }> = [];
      // Fill up to dividerCol
      let x = 0;
      for (const ch of leftText) {
        if (x >= dividerCol) break;
        const isCJK = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60]/.test(ch);
        if (isCJK) {
          cells.push({ char: ch, width: 2 });
          cells.push({ char: '', width: 0 });
          x += 2;
        } else {
          cells.push({ char: ch, width: 1 });
          x += 1;
        }
      }
      while (cells.length < dividerCol) {
        cells.push({ char: ' ', width: 1 });
      }
      // Place divider character at exact dividerCol
      cells[dividerCol] = { char: dividerChar, width: 1 };
      // Fill right side
      let rx = dividerCol + 1;
      for (const ch of rightText) {
        if (rx >= totalCols) break;
        const isCJK = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60]/.test(ch);
        if (isCJK) {
          cells.push({ char: ch, width: 2 });
          cells.push({ char: '', width: 0 });
          rx += 2;
        } else {
          cells.push({ char: ch, width: 1 });
          rx += 1;
        }
      }
      while (cells.length < totalCols) {
        cells.push({ char: '', width: 1 });
      }
      return createMockBufferLine(cells, totalCols);
    }

    // =========================================================================
    // HISTOGRAM THRESHOLD TESTS (CRITICAL QUALITY REQUIREMENT)
    // =========================================================================

    it('exports a 0.6 (60%) divider threshold constant', () => {
      expect(PANE_DIVIDER_THRESHOLD).toBe(0.6);
    });

    it('CRITICAL: recognizes column 40 as a pane divider when the majority of rows (8/10 >= 0.6) contain vertical bar', () => {
      // 10-row viewport: 8 rows have '│' at col 40 (80% presence >= 60% threshold).
      // 2 rows are title or junction bars without '│'.
      const lines: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 10; r++) {
        if (r === 0 || r === 9) {
          // Top/bottom border without vertical bar at col 40
          lines.push(buildTerminalLine('─'.repeat(80), 80));
        } else {
          lines.push(makeDividedLine(`left row ${r}`, 40, `right row ${r}`));
        }
      }
      const term = createGridMockTerm(lines, 80);

      // Touching inside left pane (col 10) resolves band to cols 0..39
      const leftBand = paneColumnBand(term, 10, 3);
      expect(leftBand).toEqual({ startCol: 0, endCol: 39 });

      // Touching inside right pane (col 60) resolves band to cols 41..79
      const rightBand = paneColumnBand(term, 60, 3);
      expect(rightBand).toEqual({ startCol: 41, endCol: 79 });
    });

    it('CRITICAL: does NOT misidentify column 40 as a pane divider when only a single row (1/10 < 0.6) contains a vertical bar', () => {
      // 10-row viewport: only row 2 happens to contain a pipe or vertical bar at col 40
      // (e.g. from an incidental shell pipeline `cat data | grep text` or markdown table row).
      // All other 9 rows are ordinary code output.
      const lines: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 10; r++) {
        if (r === 2) {
          lines.push(makeDividedLine('echo test', 40, 'grep pattern'));
        } else {
          lines.push(buildTerminalLine(`normal console output line ${r}`, 80));
        }
      }
      const term = createGridMockTerm(lines, 80);

      // Because 1/10 (10%) is well below the 0.6 threshold, col 40 must NOT be treated as a divider!
      // Tapping at col 10 or col 50 must return the full width of the terminal line.
      const bandLeft = paneColumnBand(term, 10, 2);
      expect(bandLeft).toEqual({ startCol: 0, endCol: 79 });

      const bandRight = paneColumnBand(term, 50, 2);
      expect(bandRight).toEqual({ startCol: 0, endCol: 79 });
    });

    it('strictly respects the 0.6 (60%) threshold boundary condition', () => {
      // Case 1: Exactly 6 out of 10 rows (60%) have divider -> IS divider
      const lines60: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 10; r++) {
        if (r < 6) {
          lines60.push(makeDividedLine(`left ${r}`, 30, `right ${r}`));
        } else {
          lines60.push(buildTerminalLine(`text ${r}`, 80));
        }
      }
      const term60 = createGridMockTerm(lines60, 80);
      expect(paneColumnBand(term60, 10, 0)).toEqual({ startCol: 0, endCol: 29 });

      // Case 2: Exactly 5 out of 10 rows (50%) have divider -> NOT divider (< 60%)
      const lines50: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 10; r++) {
        if (r < 5) {
          lines50.push(makeDividedLine(`left ${r}`, 30, `right ${r}`));
        } else {
          lines50.push(buildTerminalLine(`text ${r}`, 80));
        }
      }
      const term50 = createGridMockTerm(lines50, 80);
      expect(paneColumnBand(term50, 10, 0)).toEqual({ startCol: 0, endCol: 79 });
    });

    // =========================================================================
    // TOUCH POINT POSITION TESTS (LEFT PANE / RIGHT PANE / ON BORDER)
    // =========================================================================

    it('returns exact column ranges for touch points in left pane, right pane, and directly on the border', () => {
      // Viewport with vertical border at column 40 across all rows
      const lines: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 10; r++) {
        lines.push(makeDividedLine(`left ${r}`, 40, `right ${r}`));
      }
      const term = createGridMockTerm(lines, 80);

      // 1. Touch inside left pane (col 15) -> cols 0..39 (excludes divider at 40)
      const leftResult = paneColumnBand(term, 15, 4);
      expect(leftResult).toEqual({ startCol: 0, endCol: 39 });

      // 2. Touch inside right pane (col 50) -> cols 41..79 (excludes divider at 40)
      const rightResult = paneColumnBand(term, 50, 4);
      expect(rightResult).toEqual({ startCol: 41, endCol: 79 });

      // 3. Touch directly on the border column itself (col 40)
      // Returns { startCol: 40, endCol: 40 } to isolate the divider without bleeding into either pane.
      const borderResult = paneColumnBand(term, 40, 4);
      expect(borderResult).toEqual({ startCol: 40, endCol: 40 });
    });

    it('returns full terminal width when no pane dividers exist on screen', () => {
      const lines = [
        buildTerminalLine('plain shell line 1', 80),
        buildTerminalLine('plain shell line 2', 80),
        buildTerminalLine('plain shell line 3', 80),
      ];
      const term = createGridMockTerm(lines, 80);

      expect(paneColumnBand(term, 0, 0)).toEqual({ startCol: 0, endCol: 79 });
      expect(paneColumnBand(term, 45, 1)).toEqual({ startCol: 0, endCol: 79 });
      expect(paneColumnBand(term, 79, 2)).toEqual({ startCol: 0, endCol: 79 });
    });

    it('handles triple pane layouts with two vertical dividers', () => {
      // Dividers at col 25 and col 55
      const lines: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 8; r++) {
        const cells: Array<{ char: string; width: number }> = [];
        for (let c = 0; c < 80; c++) {
          if (c === 25 || c === 55) {
            cells.push({ char: '│', width: 1 });
          } else {
            cells.push({ char: 'a', width: 1 });
          }
        }
        lines.push(createMockBufferLine(cells, 80));
      }
      const term = createGridMockTerm(lines, 80);

      // Left pane (cols 0..24)
      expect(paneColumnBand(term, 10, 0)).toEqual({ startCol: 0, endCol: 24 });
      // Left border (col 25)
      expect(paneColumnBand(term, 25, 0)).toEqual({ startCol: 25, endCol: 25 });
      // Middle pane (cols 26..54)
      expect(paneColumnBand(term, 35, 0)).toEqual({ startCol: 26, endCol: 54 });
      // Right border (col 55)
      expect(paneColumnBand(term, 55, 0)).toEqual({ startCol: 55, endCol: 55 });
      // Right pane (cols 56..79)
      expect(paneColumnBand(term, 70, 0)).toEqual({ startCol: 56, endCol: 79 });
    });

    it('identifies all supported box-drawing vertical border characters', () => {
      const chars = Array.from(VERTICAL_BORDER_CHARS);
      for (const char of chars) {
        const lines: ReturnType<typeof buildTerminalLine>[] = [];
        for (let r = 0; r < 5; r++) {
          lines.push(makeDividedLine('left', 20, 'right', char, 50));
        }
        const term = createGridMockTerm(lines, 50);
        const band = paneColumnBand(term, 5, 0);
        expect(band, `failed for vertical char "${char}"`).toEqual({ startCol: 0, endCol: 19 });
      }
    });

    it('safely clamps out-of-bounds column arguments', () => {
      const lines = [buildTerminalLine('shell', 80)];
      const term = createGridMockTerm(lines, 80);

      // Negative column clamped to 0
      expect(paneColumnBand(term, -10, 0)).toEqual({ startCol: 0, endCol: 79 });
      // Over-limit column clamped to 79
      expect(paneColumnBand(term, 200, 0)).toEqual({ startCol: 0, endCol: 79 });
    });

    it('HIERARCHICAL FALLBACK: detects local vertical divider in lower sub-pane while leaving upper full-width pane intact', () => {
      // 10 rows:
      // Rows 0..4 (top pane): full-width console output without any vertical dividers
      // Row 5: horizontal split line (80 characters of '─')
      // Rows 6..9 (bottom panes): split into left pane and right pane by '│' at col 40
      const lines: ReturnType<typeof buildTerminalLine>[] = [];
      for (let r = 0; r < 5; r++) {
        lines.push(buildTerminalLine(`top full-width pane output line ${r}`, 80));
      }
      lines.push(buildTerminalLine('─'.repeat(80), 80));
      for (let r = 6; r < 10; r++) {
        lines.push(makeDividedLine(`bottom-left ${r}`, 40, `bottom-right ${r}`));
      }
      const term = createGridMockTerm(lines, 80);

      // In upper pane (row 2): global histogram found no full-height divider, and local sub-band
      // has no dividers, so touching col 10 or col 50 returns full-width [0, 79]
      expect(paneColumnBand(term, 10, 2)).toEqual({ startCol: 0, endCol: 79 });
      expect(paneColumnBand(term, 50, 2)).toEqual({ startCol: 0, endCol: 79 });

      // In lower sub-band (row 7): local divider at col 40 spans 100% (>= 80%) of the bottom band (rows 6..9)
      // Touching left sub-pane (col 10) resolves to [0, 39]
      expect(paneColumnBand(term, 10, 7)).toEqual({ startCol: 0, endCol: 39 });
      // Touching right sub-pane (col 60) resolves to [41, 79]
      expect(paneColumnBand(term, 60, 7)).toEqual({ startCol: 41, endCol: 79 });
      // Touching border directly (col 40) collapses to [40, 40]
      expect(paneColumnBand(term, 40, 7)).toEqual({ startCol: 40, endCol: 40 });
    });
  });

  describe('rectText', () => {
    function createGridMockTerm(
      lines: ReturnType<typeof buildTerminalLine>[],
      cols = 80
    ) {
      return {
        cols,
        rows: lines.length,
        buffer: {
          active: {
            viewportY: 0,
            length: lines.length,
            getLine: (y: number) => lines[y],
          },
        },
      } as unknown as Terminal;
    }

    it('extracts multi-line text joined by \\n and trims right whitespace per line', () => {
      const lines = [
        buildTerminalLine('const x = 1;     ', 80),
        buildTerminalLine('const y = 2;   ', 80),
        buildTerminalLine('const z = 3;', 80),
      ];
      const term = createGridMockTerm(lines, 80);

      // Extract rows 0..1, cols 0..15
      const text = rectText(term, {
        startCol: 0,
        endCol: 15,
        startRow: 0,
        endRow: 1,
      });

      expect(text).toBe('const x = 1;\nconst y = 2;');
    });

    it('correctly handles CJK wide characters when extracting rectangular column slices', () => {
      // Layout of line 0:
      // '项','目' -> cols 0..3
      // ':'       -> col 4
      // ' '       -> col 5
      // '日','志','服','务' -> cols 6..13 (8 columns)
      // ' '       -> col 14
      // '完','成' -> cols 15..18 (4 columns)
      const line0 = buildTerminalLine('项目: 日志服务 完成', 80);
      // Layout of line 1:
      // '模','块' -> cols 0..3
      // ':'       -> col 4
      // ' '       -> col 5
      // '终','端','选','区' -> cols 6..13 (8 columns)
      // ' '       -> col 14
      // '就','绪' -> cols 15..18 (4 columns)
      const line1 = buildTerminalLine('模块: 终端选区 就绪', 80);

      const term = createGridMockTerm([line0, line1], 80);

      // Rectangular selection strictly covering columns 6 through 13 on rows 0 and 1:
      // Notice: cols 6..13 must cleanly extract "日志服务" and "终端选区" without drifting!
      const text = rectText(term, {
        startCol: 6,
        endCol: 13,
        startRow: 0,
        endRow: 1,
      });

      expect(text).toBe('日志服务\n终端选区');
    });

    it('normalizes reversed selection coordinates (start > end)', () => {
      const line = buildTerminalLine('abcdefghijk', 80);
      const term = createGridMockTerm([line], 80);

      // Reversed: startCol: 5, endCol: 2, startRow: 0, endRow: 0
      const text = rectText(term, {
        startCol: 5,
        endCol: 2,
        startRow: 0,
        endRow: 0,
      });

      // Cols 2..5 are 'c','d','e','f'
      expect(text).toBe('cdef');
    });

    it('returns empty string for empty coordinates or missing terminal buffer', () => {
      const term = { cols: 80, buffer: null } as unknown as Terminal;
      expect(rectText(term, { startCol: 0, endCol: 10, startRow: 0, endRow: 0 })).toBe('');
    });
  });

  describe('clampRectToBand', () => {
    it('clamps selection rectangle horizontally within pane boundaries to prevent cross-pane spilling', () => {
      // Multi-pane terminal where left pane is cols 0..39 and divider is col 40
      const leftBand = { startCol: 0, endCol: 39 };

      // User drag started at col 10 in left pane, but dragged past divider into right pane at col 65
      const draggedRect = {
        startCol: 10,
        endCol: 65,
        startRow: 2,
        endRow: 4,
      };

      const clamped = clampRectToBand(draggedRect, leftBand);
      expect(clamped).toEqual({
        startCol: 10,
        endCol: 39,
        startRow: 2,
        endRow: 4,
      });
    });

    it('leaves rectangle unmodified when it already lies completely inside the pane band', () => {
      const band = { startCol: 26, endCol: 54 };
      const insideRect = {
        startCol: 30,
        endCol: 45,
        startRow: 1,
        endRow: 3,
      };

      const clamped = clampRectToBand(insideRect, band);
      expect(clamped).toEqual({
        startCol: 30,
        endCol: 45,
        startRow: 1,
        endRow: 3,
      });
    });

    it('guarantees rectText never spills into neighboring pane when clamped to band', () => {
      // Verify end-to-end: build 2 panes separated by '│' at col 40.
      // Left pane has "LEFT_PANE_DATA", right pane has "RIGHT_SECRET_DATA".
      const lines = [
        makeDividedRow('LEFT_PANE_DATA', 40, 'RIGHT_SECRET_DATA'),
        makeDividedRow('MORE_LEFT_DATA', 40, 'SECRET_RIGHT_TEXT'),
      ];
      function makeDividedRow(left: string, divCol: number, right: string) {
        const cells: Array<{ char: string; width: number }> = [];
        for (let c = 0; c < 80; c++) {
          if (c < left.length) {
            cells.push({ char: left[c], width: 1 });
          } else if (c === divCol) {
            cells.push({ char: '│', width: 1 });
          } else if (c > divCol && c - divCol - 1 < right.length) {
            cells.push({ char: right[c - divCol - 1], width: 1 });
          } else {
            cells.push({ char: ' ', width: 1 });
          }
        }
        return createMockBufferLine(cells, 80);
      }
      const term = {
        cols: 80,
        rows: 2,
        buffer: {
          active: {
            viewportY: 0,
            length: 2,
            getLine: (y: number) => lines[y],
          },
        },
      } as unknown as Terminal;

      const band = paneColumnBand(term, 5, 0);
      expect(band).toEqual({ startCol: 0, endCol: 39 });

      // User attempts cross-pane selection from col 0 to col 70
      const wildRect = { startCol: 0, endCol: 70, startRow: 0, endRow: 1 };
      const safeRect = clampRectToBand(wildRect, band);
      const extracted = rectText(term, safeRect);

      // Must contain left pane text and must NEVER contain divider '│' or right pane text
      expect(extracted).toContain('LEFT_PANE_DATA');
      expect(extracted).not.toContain('│');
      expect(extracted).not.toContain('RIGHT_SECRET_DATA');
    });
  });
});
