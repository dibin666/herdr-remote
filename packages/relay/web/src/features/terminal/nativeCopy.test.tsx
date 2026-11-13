import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '@/app/App';
import { TerminalProvider } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import * as clipboard from '@/shared/lib/clipboard';
import { createTestScreen } from '@/test/helpers/screenFixture';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';
import { TerminalView } from './TerminalView';
import { TerminalCopySurface } from './TerminalCopySurface';
import { Terminal } from '@xterm/xterm';
import type { Translate } from '@/shared/i18n';

const terminals = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const sockets = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;
const originalMatchMedia = window.matchMedia;

const fields = () => screen.getAllByTestId('terminal-copy-field') as HTMLTextAreaElement[];

async function mount(app = false) {
  render(
    app ? (
      <App />
    ) : (
      <TerminalProvider>
        <TerminalView />
      </TerminalProvider>
    ),
  );
  await waitFor(() => expect(terminals).toHaveLength(1));
  const term = terminals[0];
  const grid = createTestScreen(term.cols, term.rows);
  grid.write(0, 0, 'echo hello world');
  term.buffer.active.getLine = (row) => {
    const line = grid.getLine(row);
    return line ? { ...line, length: term.cols, isWrapped: false } : undefined;
  };
  act(() => term.emitRender?.({ start: 0, end: term.rows - 1 }));
  await waitFor(() => expect(fields()[0].value).toMatch(/^echo hello world/));
  return { term, grid };
}

function select(field: HTMLTextAreaElement, start: number, end: number) {
  act(() => {
    field.focus();
    field.setSelectionRange(start, end);
    fireEvent.select(field);
  });
}

function nativeCopy(field: HTMLTextAreaElement) {
  const setData = vi.fn();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData } });
  act(() => field.dispatchEvent(event));
  return { setData, event };
}

describe('Native terminal copy selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    terminals.length = 0;
    sockets.length = 0;
    saveSettings({ language: 'zh', token: 'native-copy-test-token' });
    window.matchMedia = ((query: string) => ({
      matches: /pointer:\s*coarse|hover:\s*none/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.useRealTimers();
  });

  it('makes read-only native copy fields available before the first long press', async () => {
    await mount();
    for (const field of fields()) {
      expect(field.readOnly).toBe(true);
      expect(field.inputMode).toBe('none');
      expect(field.wrap).toBe('off');
      expect(field).toHaveAttribute('data-terminal-copy-field');
      expect(field.style.userSelect).toBe('text');
    }
    expect(screen.queryByRole('menu', { name: '终端选择操作' })).toBeNull();
  });

  it('leaves the long-press gesture and word selection to the browser', async () => {
    const { term } = await mount();
    const field = fields()[0];
    const setSelectionRange = vi.spyOn(field, 'setSelectionRange');
    vi.useFakeTimers();
    const down = new PointerEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    act(() => field.dispatchEvent(down));
    act(() => vi.advanceTimersByTime(1_200));

    expect(down.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(setSelectionRange).not.toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: '终端选择操作' })).toBeNull();
    expect(screen.queryByTestId('terminal-selection-overlay')).toBeNull();
    act(() =>
      field.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerType: 'touch',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  });

  it('allows the system context menu through all App and terminal containers', async () => {
    await mount(true);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => fields()[0].dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu', { name: '终端选择操作' })).toBeNull();
  });

  it('uses the native copy event rather than the permission-gated clipboard API', async () => {
    const copyText = vi.spyOn(clipboard, 'copyText');
    await mount();
    const field = fields()[0];
    select(field, 0, 4);
    const { setData, event } = nativeCopy(field);
    expect(setData).toHaveBeenCalledWith('text/plain', 'echo');
    expect(event.defaultPrevented).toBe(true);
    expect(copyText).not.toHaveBeenCalled();
  });

  it('refreshes native fields on parsed output even when the renderer emits no render callback', async () => {
    const { term, grid } = await mount();
    grid.write(0, 0, 'parsed output');
    act(() => term.emitWriteParsed?.());
    await waitFor(() => expect(fields()[0].value).toMatch(/^parsed output/));
  });

  it('resumes snapshot updates when its event subscriptions are reattached', async () => {
    const term = new Terminal({ cols: 20, rows: 2 });
    const mock = term as unknown as MockTerminalInstance;
    const grid = createTestScreen(20, 2);
    grid.write(0, 0, 'echo');
    mock.buffer.active.getLine = (row) => {
      const line = grid.getLine(row);
      return line ? { ...line, length: 20, isWrapped: false } : undefined;
    };
    const box = document.createElement('div');
    const t: Translate = (key) => key;
    const { rerender } = render(
      <TerminalCopySurface
        term={term}
        surface={box}
        container={box}
        t={t}
        onSelectionChange={vi.fn()}
      />,
    );
    rerender(
      <TerminalCopySurface
        term={term}
        surface={box}
        container={box}
        t={t}
        onSelectionChange={vi.fn()}
      />,
    );
    grid.write(0, 0, 'updated');
    act(() => mock.emitWriteParsed?.());
    await waitFor(() => expect(fields()[0].value).toMatch(/^updated/));
  });

  it('keeps the text and native selection stable while new terminal output arrives', async () => {
    const { term, grid } = await mount();
    const field = fields()[0];
    select(field, 0, 4);
    const snapshot = field.value;
    grid.write(0, 0, 'changed output');
    act(() => {
      term.emitWriteParsed?.();
      term.emitRender?.({ start: 0, end: 1 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(field.value).toBe(snapshot);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
    expect(nativeCopy(field).setData).toHaveBeenCalledWith('text/plain', 'echo');
    act(() => field.blur());
    await waitFor(() => expect(fields()[0].value).toMatch(/^changed output/));
  });

  it('clears copy mode on native focusout before activeElement has updated', async () => {
    await mount();
    const field = fields()[0];
    select(field, 0, 4);
    expect(field.style.color).not.toBe('transparent');
    act(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(field.style.color).toBe('transparent');
    act(() => field.blur());
  });

  it('confines native Select All and copying to one pane', async () => {
    const { term, grid } = await mount();
    const divider = Math.floor(term.cols / 2);
    for (let row = 0; row < term.rows; row++) {
      grid.write(row, 0, 'LEFT');
      grid.write(row, divider, '│RIGHT_SECRET');
    }
    act(() => term.emitRender?.({ start: 0, end: term.rows - 1 }));
    await waitFor(() => expect(fields()).toHaveLength(2));

    const left = fields()[0];
    expect(left.value).toContain('LEFT');
    expect(left.value).not.toContain('RIGHT_SECRET');
    select(left, 0, left.value.length + 1_000);
    expect(left.selectionEnd).toBe(left.value.length);
    const { setData } = nativeCopy(left);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0][1]).toContain('LEFT');
    expect(setData.mock.calls[0][1]).not.toContain('RIGHT_SECRET');
  });

  it('copies CJK, emoji and combining characters without changing code-unit offsets', async () => {
    const { term, grid } = await mount();
    const text = '中😀 e\u0301文本';
    grid.write(0, 0, text);
    act(() => term.emitRender?.({ start: 0, end: 0 }));
    await waitFor(() => expect(fields()[0].value).toMatch(new RegExp(`^${text}`)));
    const field = fields()[0];
    select(field, 0, text.length);
    expect(nativeCopy(field).setData).toHaveBeenCalledWith('text/plain', text);
  });

  it('joins wrapped terminal lines while preserving real line breaks in native copying', async () => {
    const { term, grid } = await mount();
    grid.write(0, 0, 'https://example.com/');
    grid.write(1, 0, 'wrapped/path');
    const readLine = term.buffer.active.getLine!;
    term.buffer.active.getLine = (row) => {
      const line = readLine(row) as object | undefined;
      return line ? { ...line, isWrapped: row === 1 } : undefined;
    };
    act(() => term.emitRender?.({ start: 0, end: 1 }));
    await waitFor(() => expect(fields()[0].value).toMatch(/^https:\/\/example.com/));
    const field = fields()[0];
    select(field, 0, field.value.indexOf('wrapped/path') + 'wrapped/path'.length);
    expect(nativeCopy(field).setData).toHaveBeenCalledWith(
      'text/plain',
      'https://example.com/wrapped/path',
    );
  });

  it('keeps ordinary native-field taps as terminal input gestures', async () => {
    const { term } = await mount();
    act(() => {
      sockets[0].simulateOpen();
      sockets[0].simulateMessage(
        JSON.stringify({ type: 'ready', role: 'controller', hostId: 'host', clientId: 'client' }),
      );
    });
    const field = fields()[0];
    act(() => {
      field.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 10,
          bubbles: true,
          cancelable: true,
        }),
      );
      field.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 10,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(term.focus).toHaveBeenCalledTimes(1);
    const end = new TouchEvent('touchend', { bubbles: true, cancelable: true });
    act(() => field.dispatchEvent(end));
    expect(end.defaultPrevented).toBe(true);
  });

  it('keeps vertical drags on native fields in the terminal scroll path without opening the IME', async () => {
    const { term } = await mount();
    const field = fields()[0];
    act(() => {
      field.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      field.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 160,
          bubbles: true,
          cancelable: true,
        }),
      );
      field.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 160,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(term.scrollLines).toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
  });

  it('does not discard a native selection when the browser takes over the pointer', async () => {
    await mount();
    const field = fields()[0];
    select(field, 0, 4);
    const cancel = new PointerEvent('pointercancel', {
      pointerType: 'touch',
      bubbles: true,
      cancelable: true,
    });
    act(() => field.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(false);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
    expect(nativeCopy(field).setData).toHaveBeenCalledWith('text/plain', 'echo');
  });
});
