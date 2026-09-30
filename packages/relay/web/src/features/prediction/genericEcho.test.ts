import type { Terminal } from '@xterm/xterm';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestScreen } from '@/test/helpers/screenFixture';
import { attachPrediction } from './prediction';

function setup(prompt = 'Message: ', hidden = false, cols = 80) {
  const screen = createTestScreen(cols, 12);
  screen.write(5, 0, prompt);
  screen.setCursor(prompt.length, 5, hidden);
  const terminal = screen as unknown as Terminal;
  const parts = attachPrediction(
    terminal,
    () => terminal,
    () => undefined,
  );
  vi.spyOn(parts.screenState, 'isCursorHidden').mockImplementation(() => screen.cursor.hidden);
  let time = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const output = () => {
    time += 120;
    parts.fieldProbe.invalidate();
    parts.predictor.onServerOutput();
  };
  const type = (text: string) => parts.predictor.handleUserInput(new TextEncoder().encode(text));
  const echo = (text: string) => {
    screen.write(screen.cursor.row, screen.cursor.col, text);
    const width = Array.from(text).reduce((n, ch) => n + (/[　-鿿]/.test(ch) ? 2 : 1), 0);
    screen.setCursor(screen.cursor.col + width, screen.cursor.row);
    output();
  };
  const learn = () => {
    type('a');
    echo('a');
    type('b');
    echo('b');
    expect(parts.predictor.getState()).toBe('confident');
  };
  return { ...parts, screen, type, echo, output, learn, advance: (ms: number) => (time += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe('predictive echo learned from terminal behaviour', () => {
  it.each([
    ['custom TUI', 'Message: ', true, 80],
    ['unframed editor', '', false, 80],
    ['CMD', 'C:\\work>', false, 80],
    ['PowerShell custom prompt', '[work]::', false, 80],
    ['mobile TUI', 'Input: ', true, 40],
  ] as const)('learns %s without recognizing its prompt', (_name, prompt, hidden, cols) => {
    const t = setup(prompt, hidden, cols);
    t.type('a');
    expect(t.predictor.getOverlayItems()).toEqual([]);
    t.echo('a');
    t.type('b');
    if (!t.fieldProbe.detect()) expect(t.predictor.getOverlayItems()).toEqual([]);
    t.echo('b');
    t.type('你好');
    expect(t.predictor.getVisiblePredictions()).toEqual([
      { row: 5, col: prompt.length + 2, char: '你' },
      { row: 5, col: prompt.length + 4, char: '好' },
    ]);
    expect(
      t.screen
        .getLine(5)
        ?.getCell(prompt.length + 2)
        ?.getChars(),
    ).toBe('');
    t.echo('你好');
    expect(t.predictor.getOverlayItems()).toEqual([]);
    expect(t.predictor.getMismatchCount()).toBe(0);
  });

  it('ignores background redraws and confirms coalesced echoes', () => {
    const t = setup();
    t.type('ab');
    t.screen.write(0, 0, 'Working...');
    t.output();
    expect(t.predictor.getState()).toBe('tentative');
    t.echo('ab');
    t.type('c');
    expect(t.predictor.getVisiblePredictions()).toHaveLength(1);
  });

  it('does not learn from a matching redraw without cursor movement', () => {
    const t = setup();
    t.type('ab');
    t.screen.write(5, t.screen.cursor.col, 'ab');
    t.output();
    expect(t.predictor.getState()).toBe('tentative');
    expect(t.predictor.getOverlayItems()).toEqual([]);
  });

  it('does not mistake existing menu text traversed by the cursor for an echo', () => {
    const t = setup();
    t.screen.write(5, t.screen.cursor.col, 'ab');
    t.type('ab');
    t.screen.setCursor(t.screen.cursor.col + 2, 5);
    t.output();
    expect(t.predictor.getState()).toBe('tentative');
    t.type('c');
    expect(t.predictor.getOverlayItems()).toEqual([]);
  });

  it.each(['', '**'])('never displays text when the application echoes %j', (reply) => {
    const t = setup('Password: ');
    t.type('ab');
    t.echo(reply);
    t.advance(5_000);
    t.type('secret');
    expect(t.predictor.getOverlayItems()).toEqual([]);
  });

  it('does not expose a masked character in the debug trace', () => {
    const t = setup('Password: ');
    t.type('s');
    t.echo('*');
    expect(
      t.predictor
        .getTrace()
        .map((entry) => entry.event)
        .join('\n'),
    ).not.toContain('"s"');
  });

  it.each(['\r', '\x1b', '\x1b[A', '\x1b[<0;10;6M'])(
    'relearns after a mode-changing key %j',
    (key) => {
      const t = setup();
      t.learn();
      t.type(key);
      t.advance(2_000);
      t.type('j');
      expect(t.predictor.getOverlayItems()).toEqual([]);
      expect(t.predictor.getState()).toBe('tentative');
    },
  );

  it('demotes when the input context changes even with no predictions pending', () => {
    const t = setup();
    t.learn();
    t.screen.write(5, 0, 'Password: ');
    t.screen.setCursor(10, 5);
    t.output();
    t.type('s');
    expect(t.predictor.getOverlayItems()).toEqual([]);
  });

  it('drops stale confidence when an echo times out', () => {
    const t = setup();
    t.learn();
    t.type('c');
    t.advance(5_000);
    t.type('d');
    expect(t.predictor.getOverlayItems()).toEqual([]);
    expect(t.predictor.getState()).toBe('tentative');
  });

  it('withdraws wrong predictions and can learn again', () => {
    const t = setup();
    t.learn();
    t.type('c');
    t.echo('*');
    expect(t.predictor.getOverlayItems()).toEqual([]);
    expect(t.predictor.getState()).toBe('tentative');
    t.learn();
    t.type('d');
    expect(t.predictor.getVisiblePredictions()).toHaveLength(1);
  });

  it('predicts backspace only within text whose echoes were observed', () => {
    const t = setup();
    t.learn();
    t.type('\x7f');
    expect(t.predictor.getOverlayItems()).toContainEqual({
      row: 5,
      col: 10,
      char: ' ',
      width: 1,
      kind: 'erase',
    });
  });

  it.each(['incremental', 'redraw', 'split frame'])(
    'reconciles real ANSI %s output',
    async (mode) => {
      const terminal = new HeadlessTerminal({ cols: 80, rows: 12, allowProposedApi: true });
      const term = terminal as unknown as Terminal;
      const parts = attachPrediction(
        term,
        () => term,
        () => undefined,
      );
      const write = (bytes: string) =>
        new Promise<void>((resolve) => terminal.write(bytes, resolve));
      const output = async (bytes: string) => {
        await write(bytes);
        parts.fieldProbe.invalidate();
        if (!parts.screenState.isSynchronizing()) parts.predictor.onServerOutput();
      };
      try {
        await output('\x1b[?1049h\x1b[?25l\x1b[6;1HMessage: ');
        for (const [index, char] of Array.from('abc').entries()) {
          parts.predictor.handleUserInput(new TextEncoder().encode(char));
          if (index === 2) expect(parts.predictor.getVisiblePredictions()).toHaveLength(1);
          if (mode === 'incremental') await output(char);
          else {
            await output(`\x1b[?2026h\x1b[6;1H\x1b[2KMessage: ${'abc'.slice(0, index + 1)}`);
            if (mode === 'split frame') {
              // Half a frame must neither revoke confidence nor confirm an echo.
              expect(parts.predictor.getVisiblePredictions()).toHaveLength(index === 2 ? 1 : 0);
            }
            await output('\x1b[?2026l');
          }
          expect(parts.predictor.getOverlayItems()).toEqual([]);
        }
        expect(parts.predictor.getMismatchCount()).toBe(0);
      } finally {
        parts.screenState.dispose();
        terminal.dispose();
      }
    },
  );
});
