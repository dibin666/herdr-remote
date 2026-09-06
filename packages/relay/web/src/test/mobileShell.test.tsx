import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { saveSettings, createConnectionProfile } from '../utils/storage';
import { isMobileShellViewport, MOBILE_SHELL_MAX_WIDTH_PX } from '../utils/mobileShell';
import { computeContainerGridFit, measureCellDimensions, DEFAULT_BASE_FONT_SIZE } from '../utils/terminalFit';
import { APP_HEIGHT_VAR } from '../utils/viewportMetrics';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 800 };

const originalMatchMedia = window.matchMedia;
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

const ADMIN_STATUS_FIXTURE = {
  version: '0.1.0',
  uptimeSeconds: 100,
  startTime: new Date().toISOString(),
  serverTime: new Date().toISOString(),
  activeControllerId: 'client-1',
  activeHostId: 'host-1',
  clients: [],
  hosts: [],
  ptys: [],
  throughput: {
    bytesIn: 0,
    bytesOut: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    framesIn: 0,
    framesOut: 0,
    framesInPerSec: 0,
    framesOutPerSec: 0,
  },
  cpu: { load1m: 0, load5m: 0, load15m: 0, cpuPercent: 0, cores: 2 },
  memory: { rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 1000 },
  eventLoopDelay: { p50Ms: 1, p99Ms: 2, maxMs: 3 },
  cleanup: {
    staleClientsPurged: 0,
    closedPtysCleaned: 0,
    deadConnectionsClosed: 0,
    idleHostsTerminated: 0,
  },
  protocolVersion: 1,
};

function setViewport({ width, height }: { width: number; height: number }): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

function setPointerKind(kind: 'coarse' | 'fine'): void {
  window.matchMedia = ((query: string) => ({
    matches: kind === 'coarse' && /pointer:\s*coarse|hover:\s*none/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Stand in for the shrunken viewport an open soft keyboard leaves behind. */
function setVisualViewport(value: { width: number; height: number } | null): void {
  Object.defineProperty(window, 'visualViewport', {
    value: value
      ? {
          width: value.width,
          height: value.height,
          offsetTop: 0,
          addEventListener() {},
          removeEventListener() {},
        }
      : undefined,
    writable: true,
    configurable: true,
  });
}

const settle = (ms = 60) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Bring the relay session up, in the given role, the way the server would. */
const openSession = (role: 'controller' | 'viewer', controllerId?: string) =>
  act(() => {
    const socket = webSocketInstances[0];
    socket.simulateOpen();
    socket.simulateMessage(
      JSON.stringify({
        type: 'ready',
        role,
        controllerId: controllerId ?? (role === 'controller' ? 'client-me' : undefined),
        hostId: 'host-1',
        clientId: 'client-me',
      })
    );
  });

const renderPhoneApp = async () => {
  const utils = render(<App />);
  await waitFor(() => expect(xtermInstances.length).toBe(1));
  await settle();
  return utils;
};

const openSheet = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('mobile-chrome-trigger'));
  });
  return screen.getByTestId('mobile-control-sheet');
};

describe('Mobile shell selection', () => {
  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    setVisualViewport(null);
  });

  it('picks the phone shell for a finger-driven handset in either orientation', () => {
    setPointerKind('coarse');

    setViewport(PHONE);
    expect(isMobileShellViewport()).toBe(true);

    // Landscape phone: wider than the typography breakpoint, still a phone.
    setViewport({ width: 844, height: 390 });
    expect(isMobileShellViewport()).toBe(true);
  });

  it('leaves wide touch screens and every mouse-driven window on the desktop shell', () => {
    setPointerKind('coarse');
    setViewport({ width: MOBILE_SHELL_MAX_WIDTH_PX + 1, height: 1180 });
    expect(isMobileShellViewport()).toBe(false);

    setPointerKind('fine');
    setViewport(DESKTOP);
    expect(isMobileShellViewport()).toBe(false);
  });

  it('uses the width when a narrow window has a precise pointer', () => {
    // Desktop devtools emulating a phone reports a mouse; the chrome still does
    // not fit, so the phone shell is the right one.
    setPointerKind('fine');
    setViewport({ width: 420, height: 900 });
    expect(isMobileShellViewport()).toBe(true);

    // The landscape-phone band must use the same safe shell even when Chrome
    // is in desktop mode and reports a fine pointer.
    setViewport({ width: 800, height: 500 });
    expect(isMobileShellViewport()).toBe(true);
  });
});

describe('Phone shell shows the agent terminal and nothing else', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
    saveSettings({ token: 'test-token-mobile-shell' });
    setPointerKind('coarse');
    setViewport(PHONE);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ADMIN_STATUS_FIXTURE),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    setVisualViewport(null);
  });

  it('renders compact bottom switching and latency status on phones', async () => {
    await renderPhoneApp();

    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Admin$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Terminal$/i })).toBeNull();

    // The whole main area is the terminal, and it is visible and interactive.
    const layer = screen.getByTestId('terminal-layer');
    expect(layer.className).toContain('top-12');
    expect(layer.className).toContain('bottom-11');
    expect(layer.style.visibility).toBe('visible');

    const topbar = screen.getByTestId('mobile-topbar');
    expect(topbar.className).toContain('h-12');
    expect(topbar).toContainElement(screen.getByTestId('mobile-chrome-trigger'));
    expect(layer.style.pointerEvents).toBe('auto');

    const statusBar = screen.getByTestId('mobile-status-bar');
    expect(statusBar).toContainElement(screen.getByRole('button', { name: 'Switch Herdr instance' }));
    expect(statusBar).toHaveTextContent('RTT');
    expect(statusBar).toHaveTextContent('—');

    // The status bar stays visible while the larger control sheet is closed.
    expect(screen.queryByTestId('mobile-control-sheet')).toBeNull();
  });

  it('switches saved Herdr profiles from the persistent bottom bar', async () => {
    const office = createConnectionProfile({
      id: 'profile-office',
      displayName: 'Office',
      wsUrl: '/ws/client',
      token: 'office-token-123456789',
      hostId: 'host-office',
    });
    const home = createConnectionProfile({
      id: 'profile-home',
      displayName: 'Home',
      wsUrl: '/ws/client',
      token: 'home-token-123456789',
      hostId: 'host-home',
    });
    saveSettings({
      profiles: [office, home],
      activeProfileId: office.id,
      wsUrl: office.wsUrl,
      token: office.token,
    });

    await renderPhoneApp();

    const statusBar = screen.getByTestId('mobile-status-bar');
    const switcher = within(statusBar).getByRole('button', { name: 'Switch Herdr instance' });
    expect(switcher).toHaveTextContent('Office');
    fireEvent.click(switcher);

    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('bottom-full');
    expect(menu.className).not.toContain('top-full');
    expect(menu).toHaveTextContent('Home');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Home/ }));
    await waitFor(() => expect(within(statusBar).getByRole('button', { name: 'Switch Herdr instance' })).toHaveTextContent('Home'));
  });

  it('folds the desktop header on a narrow fine-pointer window too', async () => {
    // A phone browser in desktop-site mode can report a fine primary pointer.
    // The header still cannot fit the view switcher and action strip in this
    // width, so controls must stay in the collision-free sheet.
    setPointerKind('fine');
    setViewport({ width: 800, height: 500 });

    await renderPhoneApp();

    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Admin$/i })).toBeNull();
    expect(screen.getByTestId('mobile-chrome-trigger')).toBeInTheDocument();
  });

  it('clips the shell in both axes so nothing can overflow sideways', async () => {
    await renderPhoneApp();

    const shell = screen.getByTestId('app-shell');
    expect(shell.className).toContain('overflow-hidden');
    expect(shell.className).toContain('w-full');

    // The terminal region is the flex child that absorbs the leftover height.
    const mainArea = screen.getByTestId('terminal-layer').parentElement as HTMLElement;
    expect(mainArea.className).toContain('flex-1');
    expect(mainArea.className).toContain('min-h-0');
    expect(mainArea.className).toContain('overflow-hidden');
  });

  it('keeps the compact key toolbar inside the visual-viewport-sized shell', async () => {
    // An open soft keyboard leaves a 420px-tall visual viewport under a 780px
    // layout viewport.
    setVisualViewport({ width: PHONE.width, height: 420 });

    await renderPhoneApp();

    // The shell is sized from that, not from the layout viewport...
    expect(document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('420px');

    // ...and the toolbar is a flow child of it, below the terminal region,
    // rather than pinned to the layout viewport where the keyboard would cover
    // it. `fixed` would break exactly that.
    const shell = screen.getByTestId('app-shell');
    const toolbar = screen.getByTestId('key-toolbar');
    expect(shell.contains(toolbar)).toBe(true);
    expect(toolbar.className).not.toContain('fixed');
    expect(toolbar.className).toContain('shrink-0');

    const terminalMain = document.querySelector('#terminal-container')?.closest('main');
    expect(terminalMain).toBeTruthy();
    expect(
      (terminalMain as HTMLElement).compareDocumentPosition(toolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('opens the PTY at the phone grid instead of the 80x24 protocol default', async () => {
    // The hello frame is the only geometry a client that never holds the
    // control lease is guaranteed to get through, so it has to carry the real
    // grid. Left at 80x24 the agent painted 24 rows into a ~46-row terminal
    // and ran 30 columns off the right edge.
    await renderPhoneApp();
    act(() => webSocketInstances[0].simulateOpen());

    const hello = JSON.parse(webSocketInstances[0].sent[0] as string);
    expect(hello.type).toBe('hello');

    const cell = measureCellDimensions(null, DEFAULT_BASE_FONT_SIZE);
    const seeded = computeContainerGridFit({
      width: PHONE.width,
      height: PHONE.height,
      cellWidth: cell.cellWidth,
      cellHeight: cell.cellHeight,
    });
    expect({ cols: hello.cols, rows: hello.rows }).toEqual(seeded);
    expect({ cols: hello.cols, rows: hello.rows }).not.toEqual({ cols: 80, rows: 24 });
  });

  it('wraps the shortcut keys instead of running them off the screen edge', async () => {
    await renderPhoneApp();

    const row = screen.getByTestId('key-toolbar-row');
    expect(row.className).toContain('flex-wrap');
    // Both of these hide keys on a narrow screen: one clips them past the right
    // edge, the other spreads what is left into chasms.
    expect(row.className).not.toContain('flex-nowrap');
    expect(row.className).not.toContain('overflow-x-auto');
    expect(row.className).not.toContain('justify-between');
  });
});

describe('Phone control sheet', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
    saveSettings({ token: 'test-token-mobile-sheet' });
    setPointerKind('coarse');
    setViewport(PHONE);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ADMIN_STATUS_FIXTURE),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    setVisualViewport(null);
  });

  it('reaches connection status, the shared-session state, settings, pairing and Admin', async () => {
    await renderPhoneApp();
    openSession('controller');

    const sheet = await openSheet();

    // Connection state, which the phone shell has no banner for.
    expect(within(sheet).getByText(/^Live$/)).toBeInTheDocument();

    // Input is not a lease to be claimed: this window already has it, and the
    // sheet says so rather than offering a control that does nothing.
    expect(within(sheet).getByText(/Full control/i)).toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: /Claim Control|Release Control|Takeover/i })
    ).toBeNull();

    expect(within(sheet).getByRole('button', { name: /Terminal Settings/i })).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: /Connection & pairing|Connection and Pairing Settings/i })
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: /Admin dashboard|Open Admin dashboard/i })
    ).toBeInTheDocument();
  });

  it('reports how many windows share the terminal', async () => {
    await renderPhoneApp();
    openSession('controller');

    act(() => {
      webSocketInstances[0].simulateMessage(
        JSON.stringify({
          type: 'control_state',
          role: 'controller',
          controllerId: 'client-me',
          clientCount: 3,
        })
      );
    });

    const sheet = await openSheet();
    expect(within(sheet).getByText(/3 windows/i)).toBeInTheDocument();
  });

  it('closes when the terminal area is tapped, handing input back to the terminal', async () => {
    await renderPhoneApp();
    await openSheet();

    // The scrim covers the terminal, so a tap on the terminal area lands here.
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-sheet-scrim'));
    });

    expect(screen.queryByTestId('mobile-control-sheet')).toBeNull();
    expect(screen.queryByTestId('mobile-sheet-scrim')).toBeNull();

    const layer = screen.getByTestId('terminal-layer');
    expect(layer.style.visibility).toBe('visible');
    expect(layer.style.pointerEvents).toBe('auto');
  });

  it('closes on Escape without modifiers and strictly ignores Ctrl/Alt/Meta+Escape without stopPropagation', async () => {
    await renderPhoneApp();
    const sheet = await openSheet();
    expect(sheet).toBeInTheDocument();

    // 1. Fire Ctrl+Escape -> sheet must stay open, preventDefault/stopPropagation NOT called
    const ctrlEsc = new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, bubbles: true, cancelable: true });
    const pdSpy1 = vi.spyOn(ctrlEsc, 'preventDefault');
    const spSpy1 = vi.spyOn(ctrlEsc, 'stopPropagation');
    window.dispatchEvent(ctrlEsc);
    expect(screen.getByTestId('mobile-control-sheet')).toBeInTheDocument();
    expect(pdSpy1).not.toHaveBeenCalled();
    expect(spSpy1).not.toHaveBeenCalled();

    // 2. Fire Alt+Escape -> sheet must stay open
    const altEsc = new KeyboardEvent('keydown', { key: 'Escape', altKey: true, bubbles: true, cancelable: true });
    const pdSpy2 = vi.spyOn(altEsc, 'preventDefault');
    const spSpy2 = vi.spyOn(altEsc, 'stopPropagation');
    window.dispatchEvent(altEsc);
    expect(screen.getByTestId('mobile-control-sheet')).toBeInTheDocument();
    expect(pdSpy2).not.toHaveBeenCalled();
    expect(spSpy2).not.toHaveBeenCalled();

    // 3. Fire Meta+Escape -> sheet must stay open
    const metaEsc = new KeyboardEvent('keydown', { key: 'Escape', metaKey: true, bubbles: true, cancelable: true });
    const pdSpy3 = vi.spyOn(metaEsc, 'preventDefault');
    const spSpy3 = vi.spyOn(metaEsc, 'stopPropagation');
    window.dispatchEvent(metaEsc);
    expect(screen.getByTestId('mobile-control-sheet')).toBeInTheDocument();
    expect(pdSpy3).not.toHaveBeenCalled();
    expect(spSpy3).not.toHaveBeenCalled();

    // 4. Fire clean Escape on sheet -> closes sheet
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('mobile-control-sheet')).toBeNull();
  });

  it('never rebuilds, disposes or re-fits the terminal when it opens and closes', async () => {
    await renderPhoneApp();
    const term = xtermInstances[0];
    const resizesBefore = term.resizeCalls.length;
    const grid = { cols: term.cols, rows: term.rows };

    await openSheet();
    expect(xtermInstances.length).toBe(1);
    expect(term.disposed).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-sheet-scrim'));
    });
    await settle();

    // Same instance, same grid: the sheet is stacked over the terminal, not
    // laid out beside it, so no box it is measured from ever changed.
    expect(xtermInstances.length).toBe(1);
    expect(xtermInstances[0]).toBe(term);
    expect(term.disposed).toBe(false);
    expect(term.dispose).not.toHaveBeenCalled();
    expect({ cols: term.cols, rows: term.rows }).toEqual(grid);
    expect(term.resizeCalls.length).toBe(resizesBefore);
  });

  it('keeps the terminal alive across Admin and repaints it on the way back', async () => {
    await renderPhoneApp();
    const term = xtermInstances[0];

    const sheet = await openSheet();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: /Admin dashboard|Open Admin dashboard/i }));
    });

    expect(await screen.findByText(/Admin Dashboard|System Administration/i)).toBeInTheDocument();
    // The sheet gets out of the way, and the terminal is hidden but mounted.
    expect(screen.queryByTestId('mobile-control-sheet')).toBeNull();
    expect(xtermInstances.length).toBe(1);
    expect(term.disposed).toBe(false);
    expect(screen.getByTestId('terminal-layer').style.visibility).toBe('hidden');
    // No phone chrome floating over the Admin view.
    expect(screen.queryByTestId('mobile-chrome-trigger')).toBeNull();

    const refreshesBefore = term.refreshCount;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Return to Terminal/i }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(xtermInstances.length).toBe(1);
    expect(term.refreshCount).toBeGreaterThan(refreshesBefore);
    expect(screen.getByTestId('terminal-layer').style.visibility).toBe('visible');
    expect(screen.getByTestId('mobile-chrome-trigger')).toBeInTheDocument();
  });

  it('sends real key input to the PTY while holding the control lease', async () => {
    await renderPhoneApp();
    openSession('controller');

    const sentBefore = webSocketInstances[0].sent.length;
    await act(async () => {
      fireEvent.click(screen.getByTitle('Escape (ESC)'));
    });

    const binaryFrames = webSocketInstances[0].sent
      .slice(sentBefore)
      .filter((frame): frame is Uint8Array => typeof frame !== 'string');
    expect(binaryFrames).toHaveLength(1);
    expect(Array.from(binaryFrames[0])).toEqual([0x1b]);
  });
});

describe('Crossing the shell breakpoint', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
    saveSettings({ token: 'test-token-shell-flip' });
    setPointerKind('fine');
    setViewport(DESKTOP);
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    setVisualViewport(null);
  });

  it('swaps the chrome without rebuilding the terminal when the viewport changes', async () => {
    // A rotation, a resized desktop window or a tablet gaining a mouse all land
    // here. Both shells render TerminalView from the same slot in the tree, so
    // only the chrome around it may change — rebuilding it would drop the xterm
    // buffer and the live session with it.
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    const container = document.querySelector('#terminal-container');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-chrome-trigger')).toBeNull();

    // Rotate into a phone viewport.
    setPointerKind('coarse');
    setViewport(PHONE);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByTestId('mobile-chrome-trigger')).toBeInTheDocument();
    expect(xtermInstances.length).toBe(1);
    expect(xtermInstances[0]).toBe(term);
    expect(term.disposed).toBe(false);
    expect(term.dispose).not.toHaveBeenCalled();
    // Same DOM node, so the xterm surface was never torn down and re-opened.
    expect(document.querySelector('#terminal-container')).toBe(container);

    // ...and back again.
    setPointerKind('fine');
    setViewport(DESKTOP);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-chrome-trigger')).toBeNull();
    expect(xtermInstances.length).toBe(1);
    expect(xtermInstances[0]).toBe(term);
    expect(term.disposed).toBe(false);
    expect(document.querySelector('#terminal-container')).toBe(container);
  });
});

describe('Desktop shell is untouched by the phone layout', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
    saveSettings({ token: 'test-token-desktop-shell' });
    setPointerKind('fine');
    setViewport(DESKTOP);
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    setVisualViewport(null);
  });

  it('keeps the header, the view switcher and the full-width key toolbar', async () => {
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Admin$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeInTheDocument();

    // No phone chrome anywhere.
    expect(screen.queryByTestId('mobile-chrome-trigger')).toBeNull();
    expect(screen.queryByTestId('mobile-control-sheet')).toBeNull();

    // The toolbar keeps its keys grouped in the middle rather than spread to
    // both edges of a wide window.
    const row = screen.getByTestId('key-toolbar-row');
    expect(row.className).toContain('justify-center');
    expect(row.className).not.toContain('justify-between');
    expect(row.className).not.toContain('flex-nowrap');
  });

  it('collapses the key bar to a handle and restores it from there', async () => {
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /Collapse Toolbar|Hide the key bar/i }));

    expect(screen.queryByTestId('key-toolbar')).toBeNull();
    const handle = screen.getByRole('button', { name: /Expand Toolbar|Show the key bar/i });
    expect(handle).toBeInTheDocument();

    fireEvent.click(handle);
    expect(screen.getByTestId('key-toolbar')).toBeInTheDocument();
  });

  it('shows the connection banner in the layout, not folded into a sheet', async () => {
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    // The auto-connect leaves the session connecting, and on desktop that state
    // gets a full-width banner row rather than a dot on a pill.
    const banner = screen.getByText(/Connecting to relay/i);
    expect(banner).toBeInTheDocument();
    expect(banner.closest('aside')).toBeInTheDocument();
  });
});

afterEach(() => {
  if (originalVisualViewport) {
    Object.defineProperty(window, 'visualViewport', originalVisualViewport);
  }
});
