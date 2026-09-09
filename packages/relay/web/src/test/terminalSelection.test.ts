import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  pointToCell,
  wordRangeAt,
  lineRangeAt,
  screenText,
  scrollbackText,
  DEFAULT_WORD_SEPARATORS,
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
    translateToString(trimRight = false) {
      let str = textWithWidths.map((item) => item.char).join('');
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
});
