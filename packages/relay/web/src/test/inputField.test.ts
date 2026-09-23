import { describe, expect, it } from 'vitest';
import { detectInputField, InputFieldTracker, type FieldScreen, type InputField } from '../utils/inputField';
import {
  createTestScreen,
  listScreenFixtures,
  loadScreenFixture,
  screenFromFixture,
  type TestScreen,
} from './helpers/screenFixture';

function detectFixture(name: string): InputField | null {
  const screen = screenFromFixture(loadScreenFixture(name));
  return detectInputField(screen, screen.cursor);
}

type Expected = null | { kind: InputField['kind']; startCol: number; endCol: number; vimInsert?: boolean | null };

/**
 * What each screen captured from Herdr 0.9.1 should be read as. Expectations
 * live here rather than in the fixtures so re-capturing screens can never
 * quietly rewrite them.
 */
const EXPECTED: Record<string, Expected> = {
  'desktop-claude-empty': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-typed': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-normal': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: false },
  'desktop-claude-normal-home': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: false },
  'desktop-claude-insert-again': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-cleared': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-cjk': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-cjk-more': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-wrapped': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-slash-suggest': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-question': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: false },
  'desktop-claude-bang': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-bang-typed': { kind: 'rule', startCol: 28, endCol: 120, vimInsert: true },
  'desktop-claude-model-menu': null,
  'desktop-claude-trust': null,
  'desktop-codex-empty': { kind: 'prompt', startCol: 28, endCol: 120 },
  'desktop-codex-typed': { kind: 'prompt', startCol: 28, endCol: 120 },
  'desktop-codex-trust': null,
  'desktop-fish-empty': { kind: 'prompt', startCol: 73, endCol: 120 },
  'desktop-fish-typed': { kind: 'prompt', startCol: 73, endCol: 120 },
  'desktop-fish-autosuggest': { kind: 'prompt', startCol: 73, endCol: 120 },
  'desktop-fish-password': null,
  'desktop-herdr-help': null,
  'desktop-herdr-workspaces': null,
  'desktop-less': null,
  'desktop-pi-empty': { kind: 'frame', startCol: 28, endCol: 117 },
  'desktop-pi-typed': { kind: 'frame', startCol: 28, endCol: 117 },
  'desktop-pi-settings': null,
  'desktop-split-fish': { kind: 'prompt', startCol: 74, endCol: 119 },
  'desktop-split-claude': { kind: 'rule', startCol: 76, endCol: 119, vimInsert: true },
  'desktop-split-claude-typed': { kind: 'rule', startCol: 76, endCol: 119, vimInsert: true },
  'desktop-vim-normal': null,
  'desktop-vim-insert': null,
  'mobile-claude-empty': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-typed': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-normal': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: false },
  'mobile-claude-normal-home': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: false },
  'mobile-claude-insert-again': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-cleared': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-cjk': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-cjk-more': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-wrapped': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-slash-suggest': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-question': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: false },
  'mobile-claude-bang': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-bang-typed': { kind: 'rule', startCol: 2, endCol: 48, vimInsert: true },
  'mobile-claude-model-menu': null,
  'mobile-codex-empty': { kind: 'prompt', startCol: 2, endCol: 48 },
  'mobile-codex-typed': { kind: 'prompt', startCol: 2, endCol: 48 },
  // fish's prompt fills a phone-width row; the command starts on the next one.
  'mobile-fish-empty': { kind: 'prompt', startCol: 0, endCol: 48 },
  'mobile-fish-typed': { kind: 'prompt', startCol: 0, endCol: 48 },
  'mobile-fish-autosuggest': { kind: 'prompt', startCol: 0, endCol: 48 },
  'mobile-fish-password': null,
  'mobile-herdr-help': null,
  'mobile-herdr-workspaces': null,
  'mobile-less': null,
  'mobile-pi-empty': { kind: 'frame', startCol: 2, endCol: 45 },
  'mobile-pi-typed': { kind: 'frame', startCol: 2, endCol: 45 },
  'mobile-pi-settings': null,
  'mobile-vim-normal': null,
  'mobile-vim-insert': null,
};

describe('detectInputField on captured Herdr screens', () => {
  it('has an expectation for every captured screen', () => {
    expect(listScreenFixtures()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`reads ${name} as ${expected ? expected.kind : 'no input field'}`, () => {
      const field = detectFixture(name);
      if (expected === null) {
        expect(field).toBeNull();
        return;
      }
      expect(field).not.toBeNull();
      expect(field!.kind).toBe(expected.kind);
      expect(field!.startCol).toBe(expected.startCol);
      expect(field!.endCol).toBe(expected.endCol);
      if (expected.vimInsert !== undefined) expect(field!.vimInsert).toBe(expected.vimInsert);
      const fixture = loadScreenFixture(name);
      expect(field!.caretCol).toBe(fixture.cursor.x);
      expect(field!.row).toBe(fixture.cursor.y);
    });
  }

  it('keys a Claude box by its bottom rule, so the key survives the box growing upwards', () => {
    const typed = detectFixture('desktop-claude-typed')!;
    const wrapped = detectFixture('mobile-claude-wrapped')!;
    expect(typed.key).toBe(detectFixture('desktop-claude-cjk')!.key);
    expect(wrapped.key).toBe(detectFixture('mobile-claude-typed')!.key);
  });

  it('marks an empty agent box, and an empty Codex line behind its dim placeholder', () => {
    expect(detectFixture('desktop-claude-empty')!.empty).toBe(true);
    expect(detectFixture('desktop-claude-typed')!.empty).toBe(false);
    expect(detectFixture('desktop-codex-empty')!.empty).toBe(true);
    expect(detectFixture('desktop-pi-empty')!.empty).toBe(true);
  });

  it('treats a glyph-only prompt as an agent and a shell prompt as a shell', () => {
    expect(detectFixture('desktop-codex-typed')!.agentLike).toBe(true);
    expect(detectFixture('desktop-fish-typed')!.agentLike).toBe(false);
  });
});

function dimEverything(screen: TestScreen): void {
  for (let row = 0; row < screen.rows; row++) {
    for (let col = 0; col < screen.cols; col++) screen.setCell(row, col, { dim: true });
  }
}

describe('detectInputField edge cases', () => {
  it('refuses a field that a Herdr overlay has dimmed', () => {
    for (const name of ['desktop-claude-typed', 'desktop-pi-typed']) {
      const screen = screenFromFixture(loadScreenFixture(name));
      dimEverything(screen);
      expect(detectInputField(screen, screen.cursor)).toBeNull();
    }
  });

  it('only trusts a prompt line while the cursor is visible', () => {
    const screen = screenFromFixture(loadScreenFixture('desktop-fish-typed'));
    expect(detectInputField(screen, { ...screen.cursor, hidden: true })).toBeNull();
  });

  it('refuses a numbered choice even between rules', () => {
    const screen = createTestScreen(40, 6);
    screen.write(1, 0, '─'.repeat(40));
    screen.write(2, 0, '❯ 1. Yes');
    screen.write(3, 0, '─'.repeat(40));
    expect(detectInputField(screen, { row: 2, col: 2, hidden: true })).toBeNull();
  });

  it("finds -- INSERT -- under the taller status area Claude shows while it works", () => {
    const screen = createTestScreen(60, 20);
    screen.write(4, 0, '─'.repeat(60));
    screen.write(5, 0, '❯ typing ahead');
    screen.write(6, 0, '─'.repeat(60));
    ['[Opus]', '✓ Bash ×20', 'Context 42%', '1 CLAUDE.md', '✓ agent: done', '~file.ts(+1)'].forEach((text, i) =>
      screen.write(7 + i, 2, text)
    );
    screen.write(13, 2, '-- INSERT -- ⏵⏵ bypass permissions on');
    expect(detectInputField(screen, { row: 5, col: 14, hidden: true })).toMatchObject({ kind: 'rule', vimInsert: true });
  });

  it('stops reading status rows at the bottom border of its pane', () => {
    // Two panes stacked; the lower one shows a menu hint that is not ours.
    const screen = createTestScreen(30, 18);
    screen.write(0, 0, `┌${'─'.repeat(28)}┐`);
    for (let row = 1; row < 12; row++) screen.write(row, 0, `│${' '.repeat(28)}│`);
    screen.write(9, 1, '─'.repeat(28));
    screen.write(10, 1, '❯ hi');
    screen.write(11, 1, '─'.repeat(28));
    screen.write(12, 0, `└${'─'.repeat(28)}┘`);
    screen.write(13, 0, `┌${'─'.repeat(28)}┐`);
    for (let row = 14; row < 17; row++) screen.write(row, 0, `│${' '.repeat(28)}│`);
    screen.write(14, 1, '  Esc to cancel');
    screen.write(17, 0, `└${'─'.repeat(28)}┘`);
    expect(detectInputField(screen, { row: 10, col: 5, hidden: true })).toMatchObject({ kind: 'rule' });
  });

  it('refuses a box whose hint line says it is a menu', () => {
    const screen = createTestScreen(40, 6);
    screen.write(1, 0, '─'.repeat(40));
    screen.write(2, 0, '❯ ');
    screen.write(3, 0, '─'.repeat(40));
    screen.write(4, 0, '  Enter to confirm · Esc to cancel');
    expect(detectInputField(screen, { row: 2, col: 2, hidden: true })).toBeNull();
  });

  it('does not mistake a labelled pane top border for the rule above a box', () => {
    // Taller than an input box, so only the rule check is in play.
    const screen = createTestScreen(20, 14);
    screen.write(0, 0, `┌─ claude ${'─'.repeat(9)}┐`);
    screen.write(1, 0, `│❯ hi${' '.repeat(14)}│`);
    screen.write(2, 0, `│${'─'.repeat(18)}│`);
    for (let row = 3; row < 13; row++) screen.write(row, 0, `│${' '.repeat(18)}│`);
    screen.write(13, 0, `└${'─'.repeat(18)}┘`);
    expect(detectInputField(screen, { row: 1, col: 5, hidden: true })).toBeNull();
  });

  it('does not end a pane at a `│` that is only text', () => {
    const screen = createTestScreen(40, 3);
    screen.write(1, 0, 'a │ b $ ');
    const field = detectInputField(screen, { row: 1, col: 8, hidden: false });
    expect(field).toMatchObject({ kind: 'prompt', startCol: 8, endCol: 40 });
  });

  it('uses the last terminator so a `>` in the command never extends the field into the prompt', () => {
    const screen = createTestScreen(60, 2);
    screen.write(0, 0, 'user@host ~> echo a > b');
    const field = detectInputField(screen, { row: 0, col: 23, hidden: false });
    expect(field).toMatchObject({ kind: 'prompt', startCol: 22 });
  });

  it('refuses a frame taller than an input box, such as a pane border', () => {
    const screen = createTestScreen(20, 14);
    screen.write(0, 0, `┌${'─'.repeat(18)}┐`);
    for (let row = 1; row < 13; row++) screen.write(row, 0, `│${' '.repeat(18)}│`);
    screen.write(13, 0, `└${'─'.repeat(18)}┘`);
    screen.write(5, 1, 'typing');
    expect(detectInputField(screen, { row: 5, col: 7, hidden: false })).toBeNull();
  });

  it('refuses a cursor sitting on a border or off the screen', () => {
    const screen = screenFromFixture(loadScreenFixture('desktop-fish-typed'));
    expect(detectInputField(screen, { row: 3, col: 25, hidden: false })).toBeNull();
    expect(detectInputField(screen, { row: 99, col: 0, hidden: false })).toBeNull();
  });

  it('stays within a few thousand cell reads on a large screen', () => {
    const screen = createTestScreen(200, 60);
    screen.write(58, 0, `user@host ~> ${'x'.repeat(40)}`);
    let reads = 0;
    const counting: FieldScreen = {
      ...screen,
      getLine: (row) => {
        const line = screen.getLine(row);
        if (!line) return line;
        return {
          getCell: (x, cell) => {
            reads++;
            return line.getCell(x, cell);
          },
          translateToString: line.translateToString,
        };
      },
    };
    expect(detectInputField(counting, { row: 58, col: 53, hidden: false })).not.toBeNull();
    expect(reads).toBeLessThan(3000);
  });
});

describe('InputFieldTracker', () => {
  it('treats a box that has shown -- INSERT -- and then lost it as vim normal mode', () => {
    const tracker = new InputFieldTracker();
    const insert = screenFromFixture(loadScreenFixture('desktop-claude-typed'));
    const normal = screenFromFixture(loadScreenFixture('desktop-claude-normal'));
    expect(tracker.detect(normal, normal.cursor)).not.toBeNull();
    expect(tracker.detect(insert, insert.cursor)).not.toBeNull();
    expect(tracker.detect(normal, normal.cursor)).toBeNull();
    expect(tracker.detect(insert, insert.cursor)).not.toBeNull();
  });

  it('forgets what it saw on reset', () => {
    const tracker = new InputFieldTracker();
    const insert = screenFromFixture(loadScreenFixture('desktop-claude-typed'));
    const normal = screenFromFixture(loadScreenFixture('desktop-claude-normal'));
    tracker.detect(insert, insert.cursor);
    tracker.reset();
    expect(tracker.detect(normal, normal.cursor)).not.toBeNull();
  });
});
