import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  findFirstUrl,
  findUrlAt,
  isOpenableUrl,
  linkAtCell,
  linkDisplayHost,
  logicalLineAt,
  openTerminalLink,
} from '../utils/terminalLinks';

/**
 * A link printed into the terminal opens on the device reading it.
 *
 * The two things worth pinning: a URL that wraps across rows is still one URL
 * (Herdr 0.9.1 keeps its own rendering of those intact, and the browser has to
 * match), and nothing outside the scheme allowlist ever reaches `window.open`.
 */

/** A buffer of rows, with `wrapped` marking a row that continues the one above. */
function fakeTerminal(rows: Array<{ text: string; wrapped?: boolean }>): Terminal {
  return {
    buffer: {
      active: {
        getLine: (row: number) => {
          const line = rows[row];
          if (!line) return undefined;
          return {
            isWrapped: Boolean(line.wrapped),
            translateToString: () => line.text,
          };
        },
      },
    },
  } as unknown as Terminal;
}

describe('recognising a link', () => {
  it('finds the URL covering a column and leaves the prose out of it', () => {
    const line = 'see https://herdr.dev/docs for details';

    expect(findUrlAt(line, 4)).toBe('https://herdr.dev/docs');
    expect(findUrlAt(line, 25)).toBe('https://herdr.dev/docs');
    expect(findUrlAt(line, 0)).toBeNull();
    expect(findUrlAt(line, 30)).toBeNull();
  });

  it('drops sentence punctuation but keeps a bracket the URL opened', () => {
    expect(findFirstUrl('read https://example.com/a.')).toBe('https://example.com/a');
    expect(findFirstUrl('(see https://example.com/a)')).toBe('https://example.com/a');
    expect(findFirstUrl('https://en.wikipedia.org/wiki/Terminal_(x)')).toBe(
      'https://en.wikipedia.org/wiki/Terminal_(x)',
    );
  });

  it('accepts a bare www host and a mailto, and nothing else', () => {
    expect(isOpenableUrl('www.herdr.dev')).toBe(true);
    expect(isOpenableUrl('mailto:someone@example.com')).toBe(true);
    expect(isOpenableUrl('https://herdr.dev')).toBe(true);

    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isOpenableUrl('data:text/html,<script>')).toBe(false);
    expect(isOpenableUrl('')).toBe(false);
  });

  it('names the host beside the open action', () => {
    expect(linkDisplayHost('https://github.com/herdrdev/herdr/issues/1')).toBe('github.com');
    expect(linkDisplayHost('www.herdr.dev')).toBe('www.herdr.dev');
    expect(linkDisplayHost('mailto:someone@example.com')).toBe('someone@example.com');
  });
});

describe('a link that wraps across rows', () => {
  it('joins the wrapped rows back into one URL', () => {
    const term = fakeTerminal([
      { text: 'open https://herdr.dev/a/very/lo' },
      { text: 'ng/path/to/a/page', wrapped: true },
      { text: 'next line' },
    ]);

    // The tap lands on the first row, the URL ends on the second.
    expect(linkAtCell(term, 10, 0)).toBe('https://herdr.dev/a/very/long/path/to/a/page');
    // And a tap on the continuation row resolves to the same link.
    expect(linkAtCell(term, 3, 1)).toBe('https://herdr.dev/a/very/long/path/to/a/page');
  });

  it('does not run past a row that starts its own line', () => {
    const term = fakeTerminal([
      { text: 'https://herdr.dev' },
      { text: '/not-a-continuation' },
    ]);

    expect(linkAtCell(term, 0, 0)).toBe('https://herdr.dev');
  });

  it('reports the offset of the tapped cell within the logical line', () => {
    const term = fakeTerminal([
      { text: 'abcde' },
      { text: 'fghij', wrapped: true },
    ]);

    expect(logicalLineAt(term, 2, 1)).toEqual({ text: 'abcdefghij', index: 7 });
    expect(logicalLineAt(term, 0, 9)).toBeNull();
  });
});

describe('opening a link', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an allowed URL in a new tab with no handle back to this one', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { ...window, open });

    expect(openTerminalLink('https://herdr.dev')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://herdr.dev', '_blank', 'noopener,noreferrer');
  });

  it('gives a bare www host the scheme it implies', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { ...window, open });

    expect(openTerminalLink('www.herdr.dev')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://www.herdr.dev', '_blank', 'noopener,noreferrer');
  });

  it('refuses a scheme a pane could use to run code in this page', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { ...window, open });

    expect(openTerminalLink('javascript:alert(1)')).toBe(false);
    expect(openTerminalLink('file:///etc/passwd')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
