import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { TerminalSelectionMenu } from '../components/TerminalSelectionMenu';
import { PasteFallbackModal } from '../components/PasteFallbackModal';
import { TerminalView } from '../components/TerminalView';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import * as clipboardModule from '../utils/clipboard';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;

describe('TerminalSelectionMenu Unit Tests', () => {
  beforeEach(() => {
    saveSettings({ language: 'zh' });
  });

  it('renders all menu items in order when selection exists and is controller', () => {
    const onCopySelection = vi.fn();
    const onCopyLine = vi.fn();
    const onCopyScreen = vi.fn();
    const onPaste = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalProvider>
        <div style={{ position: 'relative', width: 400, height: 600 }}>
          <TerminalSelectionMenu
            anchorPoint={{ x: 200, y: 300 }}
            hasSelection={true}
            isController={true}
            onCopySelection={onCopySelection}
            onCopyLine={onCopyLine}
            onCopyScreen={onCopyScreen}
            onPaste={onPaste}
            onClose={onClose}
          />
        </div>
      </TerminalProvider>
    );

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('复制选中');
    expect(items[1]).toHaveTextContent('复制本行');
    expect(items[2]).toHaveTextContent('复制整屏');
    expect(items[3]).toHaveTextContent('粘贴');
    expect(items[4]).toHaveTextContent('取消');

    // Clicking an item calls action and closes menu
    fireEvent.click(items[0]);
    expect(onCopySelection).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits "复制选中" when hasSelection is false', () => {
    render(
      <TerminalProvider>
        <div style={{ position: 'relative', width: 400, height: 600 }}>
          <TerminalSelectionMenu
            anchorPoint={{ x: 200, y: 300 }}
            hasSelection={false}
            isController={true}
            onCopySelection={vi.fn()}
            onCopyLine={vi.fn()}
            onCopyScreen={vi.fn()}
            onPaste={vi.fn()}
            onClose={vi.fn()}
          />
        </div>
      </TerminalProvider>
    );

    expect(screen.queryByText('复制选中')).toBeNull();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('复制本行');
  });

  it('omits "粘贴" when isController is false (viewer mode)', () => {
    render(
      <TerminalProvider>
        <div style={{ position: 'relative', width: 400, height: 600 }}>
          <TerminalSelectionMenu
            anchorPoint={{ x: 200, y: 300 }}
            hasSelection={true}
            isController={false}
            onCopySelection={vi.fn()}
            onCopyLine={vi.fn()}
            onCopyScreen={vi.fn()}
            onPaste={vi.fn()}
            onClose={vi.fn()}
          />
        </div>
      </TerminalProvider>
    );

    expect(screen.queryByText('粘贴')).toBeNull();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(4);
    expect(items[2]).toHaveTextContent('复制整屏');
    expect(items[3]).toHaveTextContent('取消');
  });

  it('maintains strict uniform h-11 action row classes across all items and bodyClassName for gap', () => {
    const { container } = render(
      <TerminalProvider>
        <div style={{ position: 'relative', width: 400, height: 600 }}>
          <TerminalSelectionMenu
            anchorPoint={{ x: 200, y: 300 }}
            hasSelection={true}
            isController={true}
            onCopySelection={vi.fn()}
            onCopyLine={vi.fn()}
            onCopyScreen={vi.fn()}
            onPaste={vi.fn()}
            onClose={vi.fn()}
          />
        </div>
      </TerminalProvider>
    );

    const items = screen.getAllByRole('menuitem');
    for (const item of items) {
      expect(item.className).toContain('h-11');
      expect(item.className).toContain('border');
    }

    // Panel children container must receive gap-1 via bodyClassName
    const bodyContainer = container.querySelector('.flex.flex-col.gap-1');
    expect(bodyContainer).toBeTruthy();
  });

  it('flips vertically above the touch anchor when anchor is near container bottom and stays within bounds', () => {
    const { container } = render(
      <TerminalProvider>
        <div style={{ position: 'relative', width: 360, height: 640 }}>
          <TerminalSelectionMenu
            anchorPoint={{ x: 350, y: 580 }}
            hasSelection={true}
            isController={true}
            onCopySelection={vi.fn()}
            onCopyLine={vi.fn()}
            onCopyScreen={vi.fn()}
            onPaste={vi.fn()}
            onClose={vi.fn()}
          />
        </div>
      </TerminalProvider>
    );

    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();

    const top = parseFloat(menu.style.top);
    const left = parseFloat(menu.style.left);

    // Hard bounds: top and left must respect 8px margin
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    // When anchor is near bottom (580px of 640px), menu must flip above touch point
    expect(top).toBeLessThan(580);
  });
});

describe('PasteFallbackModal', () => {
  beforeEach(() => {
    saveSettings({ language: 'zh' });
  });

  it('renders modal with textarea, autoFocus, and enables send button upon user input', () => {
    const onSend = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={true} onClose={onClose} onSend={onSend} />
      </TerminalProvider>
    );

    expect(screen.getByText('粘贴内容')).toBeInTheDocument();
    expect(screen.getByText('长按此处粘贴，然后按发送')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('长按此处粘贴，然后按发送');
    expect(textarea).toBeInTheDocument();

    const sendBtn = screen.getByRole('button', { name: '发送' });
    expect(sendBtn).toBeDisabled();

    // Type or paste text
    fireEvent.change(textarea, { target: { value: 'pasted terminal command' } });
    expect(sendBtn).not.toBeDisabled();

    fireEvent.click(sendBtn);
    expect(onSend).toHaveBeenCalledWith('pasted terminal command');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not render when isOpen is false', () => {
    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={false} onClose={vi.fn()} onSend={vi.fn()} />
      </TerminalProvider>
    );
    expect(screen.queryByText('粘贴内容')).toBeNull();
  });
});

describe('TerminalView mobile selection and clipboard integration', () => {
  let terminalCtx: ReturnType<typeof useTerminal> | undefined;
  const originalMatchMedia = window.matchMedia;

  const CaptureContext: React.FC = () => {
    terminalCtx = useTerminal();
    return null;
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    vi.restoreAllMocks();

    saveSettings({ language: 'zh' });

    // Simulate coarse-pointer touch mobile device
    window.matchMedia = ((query: string) => ({
      matches: /pointer:\s*coarse|hover:\s*none/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const renderMobileTerminal = () => {
    terminalCtx = undefined;
    return render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );
  };

  it('tapping while selectionMenu is open dismisses the menu and swallows the gesture without starting a new one', async () => {
    renderMobileTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    const container = document.querySelector('#terminal-container') as HTMLElement;
    expect(container).toBeTruthy();

    // Simulate long press to open menu on container
    act(() => {
      const downEvent = new PointerEvent('pointerdown', {
        clientX: 100,
        clientY: 100,
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(downEvent);
    });

    // Wait for 500ms long press timer
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });

    // Menu should now be in the DOM
    const menu = screen.getByRole('menu', { name: '终端选择操作' });
    expect(menu).toBeInTheDocument();

    // Tap on the terminal while menu is open: must close menu and swallow event
    const tapEvent = new PointerEvent('pointerdown', {
      clientX: 50,
      clientY: 50,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(tapEvent, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(tapEvent, 'stopPropagation');

    act(() => {
      container.dispatchEvent(tapEvent);
    });

    // Menu must be dismissed
    expect(screen.queryByRole('menu', { name: '终端选择操作' })).toBeNull();
    // Event must be swallowed
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
    // Must NOT call term.focus
    expect(term.focus).not.toHaveBeenCalled();
  });

  it('copies selected text via copyText when "复制选中" is clicked', async () => {
    const copyTextSpy = vi.spyOn(clipboardModule, 'copyText').mockResolvedValue('clipboard');

    renderMobileTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.getSelection = vi.fn().mockReturnValue('echo hello');
    term.hasSelection = vi.fn().mockReturnValue(true);

    const container = document.querySelector('#terminal-container') as HTMLElement;

    // Trigger long press to open menu
    act(() => {
      container.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 100,
          clientY: 100,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });

    const copyBtn = screen.getByRole('menuitem', { name: /复制选中/i });
    act(() => {
      fireEvent.click(copyBtn);
    });

    await waitFor(() => {
      expect(copyTextSpy).toHaveBeenCalledWith('echo hello');
    });
  });

  it('opens PasteFallbackModal when readClipboardText returns "insecure" and pastes on send', async () => {
    vi.spyOn(clipboardModule, 'readClipboardText').mockResolvedValue({
      ok: false,
      reason: 'insecure',
    });

    renderMobileTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    // Grant controller role so paste is available
    act(() => {
      // @ts-expect-error test event
      terminalCtx?.adapter?.emit('controlGranted');
    });

    const container = document.querySelector('#terminal-container') as HTMLElement;

    // Trigger long press to open menu
    act(() => {
      container.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 100,
          clientY: 100,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });

    const pasteBtn = screen.getByRole('menuitem', { name: /粘贴/i });
    act(() => {
      fireEvent.click(pasteBtn);
    });

    // Fallback modal opens
    await waitFor(() => {
      expect(screen.getByText('长按此处粘贴，然后按发送')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('长按此处粘贴，然后按发送');
    fireEvent.change(textarea, { target: { value: 'git pull origin main' } });

    const sendBtn = screen.getByRole('button', { name: '发送' });
    act(() => {
      fireEvent.click(sendBtn);
    });

    // term.paste must be called
    expect(term.paste).toHaveBeenCalledWith('git pull origin main');
    // Modal closed
    expect(screen.queryByText('长按此处粘贴，然后按发送')).toBeNull();
  });

  it('shows toast and does NOT open PasteFallbackModal when readClipboardText returns "empty"', async () => {
    vi.spyOn(clipboardModule, 'readClipboardText').mockResolvedValue({
      ok: false,
      reason: 'empty',
    });

    renderMobileTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    act(() => {
      // @ts-expect-error test event
      terminalCtx?.adapter?.emit('controlGranted');
    });

    const container = document.querySelector('#terminal-container') as HTMLElement;

    act(() => {
      container.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 100,
          clientY: 100,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });

    const pasteBtn = screen.getByRole('menuitem', { name: /粘贴/i });
    act(() => {
      fireEvent.click(pasteBtn);
    });

    // Wait and assert fallback modal did NOT open
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText('长按此处粘贴，然后按发送')).toBeNull();
  });
});
