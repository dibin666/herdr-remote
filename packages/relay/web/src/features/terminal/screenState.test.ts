import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { attachScreenState } from './screenState';

// The real parser, not the global xterm mock: what matters is that these
// handlers see Herdr's sequences and leave xterm's own handling intact.
function createTerminal() {
  const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  return term;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe('attachScreenState', () => {
  it('follows cursor visibility, including combined private-mode sequences', async () => {
    const term = createTerminal();
    const state = attachScreenState(term);
    expect(state.isCursorHidden()).toBe(false);
    await write(term, '\x1b[?25l');
    expect(state.isCursorHidden()).toBe(true);
    await write(term, '\x1b[?1049;25h');
    expect(state.isCursorHidden()).toBe(false);
    // xterm still processed the sequence itself.
    expect(term.buffer.active.type).toBe('alternate');
  });

  it('reports a frame in progress between ?2026h and ?2026l', async () => {
    const term = createTerminal();
    const state = attachScreenState(term);
    await write(term, '\x1b[?2026hhalf a fra');
    expect(state.isSynchronizing()).toBe(true);
    await write(term, 'me\x1b[?2026l');
    expect(state.isSynchronizing()).toBe(false);
  });

  it('gives up on a frame whose end never arrived', async () => {
    let clock = 0;
    const term = createTerminal();
    const state = attachScreenState(term, () => clock);
    await write(term, '\x1b[?2026h');
    clock = 999;
    expect(state.isSynchronizing()).toBe(true);
    clock = 1000;
    expect(state.isSynchronizing()).toBe(false);
  });

  it('announces the end of a frame, and only of a frame that began', async () => {
    const term = createTerminal();
    const state = attachScreenState(term);
    let ends = 0;
    const subscription = state.onSyncEnd(() => {
      ends += 1;
    });
    await write(term, '\x1b[?2026l');
    expect(ends).toBe(0);
    await write(term, '\x1b[?2026hframe');
    expect(ends).toBe(0);
    await write(term, '\x1b[?2026l');
    expect(ends).toBe(1);
    subscription.dispose();
    await write(term, '\x1b[?2026h\x1b[?2026l');
    expect(ends).toBe(1);
  });

  it('clears both on a soft or full terminal reset', async () => {
    const term = createTerminal();
    const state = attachScreenState(term);
    await write(term, '\x1b[?25l\x1b[?2026h');
    await write(term, '\x1b[!p');
    expect(state.isCursorHidden()).toBe(false);
    expect(state.isSynchronizing()).toBe(false);
    await write(term, '\x1b[?25l\x1b[?2026h\x1bc');
    expect(state.isCursorHidden()).toBe(false);
    expect(state.isSynchronizing()).toBe(false);
  });

  it('stops observing once disposed', async () => {
    const term = createTerminal();
    const state = attachScreenState(term);
    state.dispose();
    await write(term, '\x1b[?25l');
    expect(state.isCursorHidden()).toBe(false);
  });

  it('is inert for a terminal without a parser', () => {
    const state = attachScreenState({});
    expect(state.isCursorHidden()).toBe(false);
    expect(state.isSynchronizing()).toBe(false);
    expect(() => state.dispose()).not.toThrow();
  });
});
