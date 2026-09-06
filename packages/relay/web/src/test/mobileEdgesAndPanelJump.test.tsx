import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { SettingsModal } from '../components/SettingsModal';
import { PairingModal } from '../components/PairingModal';
import { MobileTerminalShell } from '../components/MobileTerminalShell';

/**
 * Two phone-specific defects, both of them about the browser deciding where
 * things go: a terminal grid pushed against one bezel, and a page that jumped
 * the moment a panel opened.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');

/** The rules that apply only where a finger is the pointer. */
function coarsePointerBlock(): string {
  const start = CSS.indexOf('@media (pointer: coarse)');
  expect(start).toBeGreaterThan(-1);

  let depth = 0;
  for (let index = CSS.indexOf('{', start); index < CSS.length; index += 1) {
    if (CSS[index] === '{') depth += 1;
    else if (CSS[index] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, index + 1);
    }
  }
  throw new Error('unterminated @media (pointer: coarse) block');
}

describe('Phone terminal edges', () => {
  it('splits the leftover between both edges instead of banking it on the right', () => {
    // A grid of whole cells rarely divides the screen exactly. The remainder
    // used to sit entirely on the right, so text ran into the left bezel while
    // a strip of nothing followed the last column.
    const block = coarsePointerBlock();
    expect(block).toMatch(/#terminal-surface\s+\.xterm-screen\s*\{[^}]*margin-inline:\s*auto/);
  });

  it('gives the scrollbar gutter back to the grid on a touch device', () => {
    const block = coarsePointerBlock();

    // Scrolling stays; only the reserved gutter goes, because a phone has no
    // pointer to aim at a scrollbar and no width to spare for one.
    expect(block).toMatch(/overflow-y:\s*auto\s*!important/);
    expect(block).toMatch(/scrollbar-width:\s*none/);
    expect(block).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
    // Horizontal scrolling would let the first column slide out of view.
    expect(block).toMatch(/overflow-x:\s*hidden\s*!important/);
  });

  it('keeps the desktop scrollbar, where it is a control and not stolen width', () => {
    expect(CSS).toMatch(/\.xterm \.xterm-viewport\s*\{\s*overflow-y:\s*scroll\s*!important/);
  });
});

describe('Panels open without moving the page', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  const ContextCapture: React.FC<{
    onReady: (context: ReturnType<typeof useTerminal>) => void;
  }> = ({ onReady }) => {
    onReady(useTerminal());
    return null;
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originalWidth,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: originalHeight,
      writable: true,
      configurable: true,
    });
    document.documentElement.style.removeProperty('--app-height');
    vi.restoreAllMocks();
  });

  it('measures dialogs against the visible viewport, not the viewport behind the browser chrome', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
        <PairingModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    for (const dialog of screen.getAllByRole('dialog')) {
      // `vh` on a phone is the tall viewport behind the browser's own chrome:
      // a dialog sized in it reaches past the visible area and the browser
      // scrolls to compensate, which is the jump this replaces.
      expect(dialog.className).not.toMatch(/\bh-screen\b/);
      expect(dialog.getAttribute('style') || '').toContain('--app-height');

      const panel = dialog.firstElementChild as HTMLElement;
      expect(panel.className).not.toMatch(/max-h-\[90vh\]/);
      expect(panel.getAttribute('style') || '').toContain('--app-height');
    }
  });

  it('states that the terminal is shared and offers no lease to take over', () => {
    // There is no control lease any more: every paired window types into the
    // one shared terminal. The sheet therefore reports how many windows are
    // attached instead of offering a control to seize from somebody else.
    let terminalContext: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <ContextCapture onReady={(context) => { terminalContext = context; }} />
        <MobileTerminalShell
          onNavigateAdmin={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
        />
      </TerminalProvider>
    );

    act(() => {
      // @ts-expect-error adapter emit is intentionally exercised by this test
      terminalContext?.adapter?.emit('stateChange', 'connected');
      // @ts-expect-error adapter emit is intentionally exercised by this test
      terminalContext?.adapter?.emit('ready', {
        type: 'ready',
        role: 'controller',
        controllerId: 'client-local',
        hostId: 'host-1',
        clientId: 'client-local',
      });
      // @ts-expect-error adapter emit is intentionally exercised by this test
      terminalContext?.adapter?.emit('peerCount', 2);
    });

    fireEvent.click(screen.getByTestId('mobile-chrome-trigger'));
    const sheet = screen.getByTestId('mobile-control-sheet');

    expect(within(sheet).getByText(/Full control/i)).toBeInTheDocument();
    expect(within(sheet).getByText(/2 windows/i)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Takeover|Claim Control/i })).toBeNull();
    // Nothing to confirm, so nothing opens over the sheet.
    expect(screen.queryByRole('dialog', { name: /Takeover|接管/i })).toBeNull();
  });

  it.each([
    [370, 912],
    [464, 1080],
    [501, 1080],
  ])('keeps the mobile sheet bounded and independently scrollable at %dx%d', (width, height) => {
    Object.defineProperty(window, 'innerWidth', {
      value: width,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: height,
      writable: true,
      configurable: true,
    });
    document.documentElement.style.setProperty('--app-height', `${height}px`);

    render(
      <TerminalProvider>
        <MobileTerminalShell
          onNavigateAdmin={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
        />
      </TerminalProvider>
    );

    fireEvent.click(screen.getByTestId('mobile-chrome-trigger'));
    const sheet = screen.getByTestId('mobile-control-sheet');

    // Keep the sheet in the shell's viewport and let its own surface consume
    // overflow; the terminal and document must not become the scroll owner.
    expect(sheet.className).toContain('absolute');
    expect(sheet.className).toContain('inset-x-0');
    expect(sheet.className).toContain('bottom-0');
    expect(sheet.className).toContain('max-h-[85%]');
    expect(sheet.className).toContain('overflow-y-auto');
    expect(sheet.className).not.toContain('overflow-hidden');

    // A real overflow range belongs to this element, not to body. jsdom does
    // not lay out content, so provide the measured range a phone browser would
    // expose and verify that the element remains the scroll owner.
    Object.defineProperty(sheet, 'scrollHeight', { configurable: true, value: height * 2 });
    Object.defineProperty(sheet, 'clientHeight', { configurable: true, value: Math.floor(height * 0.8) });
    sheet.scrollTop = 0;
    sheet.scrollTop = 120;
    expect(sheet.scrollTop).toBe(120);
  });

  it('never asks the browser to scroll a sheet or a button into view', () => {
    const focusOptions: Array<FocusOptions | undefined> = [];
    const originalFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      focusOptions.push(options);
      return originalFocus.call(this, options);
    });
    const scrollTo = vi.spyOn(window, 'scrollTo');

    const onOpenSettings = vi.fn();
    render(
      <TerminalProvider>
        <MobileTerminalShell
          onNavigateAdmin={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={onOpenSettings}
        />
      </TerminalProvider>
    );

    act(() => {
      fireEvent.click(screen.getByTestId('mobile-chrome-trigger'));
    });

    // The sheet takes focus so Escape and the reader work, but it must not ask
    // to be scrolled into view: it is already pinned to the bottom edge.
    expect(focusOptions.length).toBeGreaterThan(0);
    expect(focusOptions.every((options) => options?.preventScroll === true)).toBe(true);

    const blur = vi.spyOn(HTMLElement.prototype, 'blur');
    const beforeScrollY = window.scrollY;
    const beforeVisualViewportTop = window.visualViewport?.offsetTop ?? null;
    act(() => {
      fireEvent.click(screen.getByLabelText(/终端设置|Terminal settings/i));
    });

    expect(onOpenSettings).toHaveBeenCalled();
    expect(window.scrollY).toBe(beforeScrollY);
    expect(window.visualViewport?.offsetTop ?? null).toBe(beforeVisualViewportTop);
    // The pressed button is blurred first: a focused element unmounting mid
    // frame is what sends the browser hunting for a place to scroll to.
    expect(blur).toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
