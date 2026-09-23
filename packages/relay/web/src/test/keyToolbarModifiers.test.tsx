import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { KeyToolbar } from '../components/KeyToolbar';
import { TerminalView } from '../components/TerminalView';
import { saveSettings } from '../utils/storage';
import { ALL_AVAILABLE_KEYS, DEFAULT_TOOLBAR_KEYS, sanitizeVirtualKeys } from '../utils/virtualKeys';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] }).__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] }).__webSocketInstances;

// Typed arrays from the Node realm fail `instanceof Uint8Array` under jsdom, so
// decode structurally instead of filtering by constructor identity.
const sentInput = () =>
  webSocketInstances[0].sent
    .filter((chunk) => typeof chunk !== 'string')
    .map((chunk) => new TextDecoder().decode(chunk as Uint8Array));

const emitTerminalData = (term: MockTerminalInstance, data: string) => {
  const onData = term.onData as unknown as { mock: { calls: Array<[(value: string) => void]> } };
  for (const [listener] of onData.mock.calls) listener(data);
};

const withShift = () => {
  const shift = ALL_AVAILABLE_KEYS.find((key) => key.id === 'shift')!;
  return [...DEFAULT_TOOLBAR_KEYS.slice(0, 3), shift, ...DEFAULT_TOOLBAR_KEYS.slice(3)];
};

async function mount() {
  render(
    <TerminalProvider>
      <TerminalView isActive={true} />
      <KeyToolbar />
    </TerminalProvider>
  );
  await waitFor(() => expect(webSocketInstances.length).toBe(1));
  act(() => {
    webSocketInstances[0].simulateOpen();
    webSocketInstances[0].simulateMessage(
      JSON.stringify({ type: 'ready', role: 'controller', controllerId: 'me', hostId: 'host-1', clientId: 'me' })
    );
  });
  webSocketInstances[0].sent.length = 0;
  return xtermInstances[0];
}

const key = (name: string) => screen.getByRole('button', { name });

describe('Key bar modifiers', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    saveSettings({ toolbarVisible: true, virtualKeys: withShift() });
  });

  it('applies a latched Ctrl to an arrow key, then releases it', async () => {
    await mount();
    fireEvent.click(key('Toggle Ctrl Lock'));
    expect(key('Toggle Ctrl Lock')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(key('Left (←)'));
    await waitFor(() => expect(sentInput()).toEqual(['\x1b[1;5D']));
    expect(key('Toggle Ctrl Lock')).toHaveAttribute('aria-pressed', 'false');
  });

  it('applies a latched Shift to a function key from the drawer', async () => {
    await mount();
    fireEvent.click(key('Toggle Shift Lock'));
    fireEvent.click(screen.getByRole('button', { name: /Function Keys/ }));
    fireEvent.click(screen.getByRole('button', { name: 'F5' }));
    await waitFor(() => expect(sentInput()).toEqual(['\x1b[15;2~']));
  });

  it("sends Shift+Tab from its own key, for Claude Code's mode cycle", async () => {
    await mount();
    fireEvent.click(key('Shift+Tab (Claude Code: cycle modes)'));
    await waitFor(() => expect(sentInput()).toEqual(['\x1b[Z']));
  });

  it('turns a latched Shift and Enter into the newline key Claude Code reads', async () => {
    await mount();
    fireEvent.click(key('Toggle Shift Lock'));
    fireEvent.click(key('Enter'));
    await waitFor(() => expect(sentInput()).toEqual(['\x1b[13;2u']));
  });

  it("applies a latched Alt to the next key from the phone's own keyboard", async () => {
    const term = await mount();
    fireEvent.click(key('Toggle Alt Lock'));
    act(() => emitTerminalData(term, 'f'));
    await waitFor(() => expect(sentInput()).toEqual(['\x1bf']));
    expect(key('Toggle Alt Lock')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the latch through mouse hover and IME commits, for the next real key', async () => {
    const term = await mount();
    fireEvent.click(key('Toggle Ctrl Lock'));
    act(() => emitTerminalData(term, '\x1b[<35;10;5M'));
    act(() => emitTerminalData(term, '你好'));
    expect(key('Toggle Ctrl Lock')).toHaveAttribute('aria-pressed', 'true');
    act(() => emitTerminalData(term, 'c'));
    // One flush carries all three; only the real key was modified.
    await waitFor(() => expect(sentInput().join('')).toBe('\x1b[<35;10;5M你好\x03'));
  });

  it('lets a ready-made chord release the latch without modifying it', async () => {
    await mount();
    fireEvent.click(key('Toggle Alt Lock'));
    fireEvent.click(key('Ctrl Chords'));
    fireEvent.click(screen.getByTitle('Ctrl+C (SIGINT)'));
    await waitFor(() => expect(sentInput()).toEqual(['\x03']));
    expect(key('Toggle Alt Lock')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Default key bar layout', () => {
  it('gives an untouched copy of an earlier default the new key', () => {
    const previous = DEFAULT_TOOLBAR_KEYS.filter((k) => k.id !== 'shift_tab');
    expect(sanitizeVirtualKeys(previous).map((k) => k.id)).toEqual(DEFAULT_TOOLBAR_KEYS.map((k) => k.id));
  });

  it("leaves a layout the user arranged alone", () => {
    const custom = DEFAULT_TOOLBAR_KEYS.filter((k) => k.id !== 'shift_tab').reverse();
    expect(sanitizeVirtualKeys(custom).map((k) => k.id)).not.toContain('shift_tab');
  });
});
