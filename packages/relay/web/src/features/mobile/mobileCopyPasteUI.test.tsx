import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { TerminalView } from '@/features/terminal/TerminalView';
import { KeyToolbar } from '@/features/keyboard/KeyToolbar';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';

const terminals = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const sockets = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

/** Native copying replaces the old terminal menu; pasting stays on the key bar. */
describe('PasteFallbackModal', () => {
  beforeEach(() => saveSettings({ language: 'zh' }));

  it('accepts native pasted text and sends it when the user confirms', () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen onClose={onClose} onSend={onSend} />
      </TerminalProvider>,
    );
    const textarea = screen.getByPlaceholderText('长按此处粘贴，然后按发送');
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'pasted terminal command' } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith('pasted terminal command');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not render while closed', () => {
    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={false} onClose={vi.fn()} onSend={vi.fn()} />
      </TerminalProvider>,
    );
    expect(screen.queryByText('粘贴内容')).toBeNull();
  });
});

describe('Mobile key-bar paste alongside native copying', () => {
  const originalMatchMedia = window.matchMedia;
  let context: ReturnType<typeof useTerminal> | undefined;
  const Probe: React.FC = () => {
    context = useTerminal();
    return null;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    terminals.length = 0;
    sockets.length = 0;
    context = undefined;
    saveSettings({ language: 'zh', toolbarVisible: true });
    window.matchMedia = ((query: string) => ({
      matches: /pointer:\s*coarse|hover:\s*none/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  async function mount(controller = true) {
    render(
      <TerminalProvider>
        <Probe />
        <TerminalView />
        <KeyToolbar compact />
      </TerminalProvider>,
    );
    await waitFor(() => expect(terminals).toHaveLength(1));
    if (!context?.adapter) throw new Error('Terminal context did not mount');
    if (controller) {
      act(() => {
        // @ts-expect-error test event
        context?.adapter?.emit('controlGranted');
      });
    }
    return vi.spyOn(context.adapter, 'sendInput');
  }

  it('opens the pinned paste box and sends text without a long-press menu', async () => {
    const sendInput = await mount();
    fireEvent.click(screen.getByTestId('paste-btn'));
    const textarea = await screen.findByPlaceholderText('长按此处粘贴，然后按发送');
    fireEvent.change(textarea, { target: { value: 'git pull origin main' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(sendInput).toHaveBeenCalledWith(new TextEncoder().encode('git pull origin main'));
    expect(screen.queryByPlaceholderText('长按此处粘贴，然后按发送')).toBeNull();
    expect(screen.queryByRole('menu', { name: '终端选择操作' })).toBeNull();
  });

  it('keeps text typed the instant the paste box appears', async () => {
    const sendInput = await mount();
    const typed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        const box = screen.queryByPlaceholderText('长按此处粘贴，然后按发送');
        if (!box) return;
        observer.disconnect();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          box,
          'git pull origin main',
        );
        box.dispatchEvent(new Event('input', { bubbles: true }));
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    fireEvent.click(screen.getByTestId('paste-btn'));
    await act(async () => {
      await typed;
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(sendInput).toHaveBeenCalledWith(new TextEncoder().encode('git pull origin main'));
  });

  it('keeps paste disabled for a viewer while native copy fields remain available', async () => {
    const sendInput = await mount(false);
    fireEvent.click(screen.getByTestId('paste-btn'));
    expect(sendInput).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('长按此处粘贴，然后按发送')).toBeNull();
    expect(screen.getAllByTestId('terminal-copy-field').length).toBeGreaterThan(0);
  });
});
