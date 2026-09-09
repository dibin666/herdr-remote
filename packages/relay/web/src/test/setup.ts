import '@testing-library/jest-dom';
import { vi, beforeEach } from 'vitest';
import { clearMemoryStorage } from '../utils/storage';

beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
    clearMemoryStorage();
  } catch {}
});

// Polyfill window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

/**
 * jsdom ships neither PointerEvent nor pointer capture, so the app would always
 * fall back to its touch path under test. Both are polyfilled to keep the
 * tested code path the same one real browsers take.
 */
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  global.PointerEvent = window.PointerEvent;
}

if (typeof Element.prototype.setPointerCapture !== 'function') {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}

/**
 * Inert WebSocket recorder. Rendering the App auto-connects on mount, and
 * jsdom's real WebSocket would dial ws://localhost and then drive the adapter's
 * reconnect backoff on live timers for the rest of the suite. Sockets stay in
 * CONNECTING unless a test opens them, so nothing fires on its own.
 * Suites that drive the protocol directly install their own mock and restore
 * this one afterwards.
 */
export class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState: number = MockWebSocket.CONNECTING;
  public binaryType = 'blob';
  public sent: unknown[] = [];
  public onopen: ((ev: unknown) => void) | null = null;
  public onmessage: ((ev: unknown) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onclose: ((ev: unknown) => void) | null = null;

  constructor(public url: string) {
    webSocketInstances.push(this);
  }

  public send(data: unknown): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  /** Drive the adapter's open handshake from a test. */
  public simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Deliver a frame to the adapter (string for JSON, ArrayBuffer for ANSI). */
  public simulateMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const webSocketInstances: MockWebSocket[] = [];
(globalThis as unknown as { __webSocketInstances: MockWebSocket[] }).__webSocketInstances =
  webSocketInstances;
global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

/**
 * Instances created by the mocked xterm Terminal, exposed on globalThis so
 * keep-alive tests can assert that navigation never constructs or disposes one.
 * Tests clear it via `__xtermInstances.length = 0` in beforeEach.
 */
export interface MockTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  writes: unknown[];
  disposed: boolean;
  refreshCount: number;
  resizeCalls: Array<{ cols: number; rows: number }>;
  focusCount: number;
  /**
   * Cell metrics the fake render service reports. Tests mutate this to stand in
   * for a font that has finished measuring, or for a different font size.
   */
  cellSize: { width: number; height: number };
  /** xterm's hidden input element, exposed for mobile focus-policy tests. */
  textarea: HTMLTextAreaElement;
  /** Minimal live cursor/scroll position exposed by xterm's buffer API. */
  buffer: {
    active: {
      cursorX: number;
      cursorY: number;
      viewportY: number;
      baseY: number;
      length?: number;
      getLine?: (y: number) => unknown;
    };
  };
  /** Drives `isMouseTrackingActive`, i.e. whether an app wants SGR reports. */
  modes: { mouseTrackingMode: string };
  [key: string]: unknown;
}

const xtermInstances: MockTerminalInstance[] = [];
(globalThis as unknown as { __xtermInstances: MockTerminalInstance[] }).__xtermInstances =
  xtermInstances;

// Mock xterm. The constructor is a plain function (not `vi.fn`) so that a test
// calling `vi.restoreAllMocks()` cannot strip its implementation.
vi.mock('@xterm/xterm', () => ({
  Terminal: function MockTerminal(opts: Record<string, unknown> = {}) {
    const instance: MockTerminalInstance = {
      options: { ...opts },
      cols: typeof opts.cols === 'number' ? opts.cols : 80,
      rows: typeof opts.rows === 'number' ? opts.rows : 24,
      writes: [],
      disposed: false,
      refreshCount: 0,
      resizeCalls: [],
      focusCount: 0,
      cellSize: { width: 9, height: 18 },
      textarea: document.createElement('textarea'),
      buffer: {
        active: {
          cursorX: 0,
          cursorY: 0,
          viewportY: 0,
          baseY: 0,
          length: 24,
          getLine: vi.fn((_y: number) => ({
            isWrapped: false,
            length: 80,
            getCell: vi.fn(() => ({
              getWidth: () => 1,
              getChars: () => ' ',
              getCode: () => 32,
            })),
            translateToString: vi.fn(() => 'mock-line-content'),
          })),
        },
      },
      modes: { mouseTrackingMode: 'none' },
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(() => {
        instance.disposed = true;
      }),
      writeln: vi.fn((data: unknown) => {
        instance.writes.push(data);
      }),
      write: vi.fn((data: unknown) => {
        instance.writes.push(data);
      }),
      refresh: vi.fn(() => {
        instance.refreshCount += 1;
      }),
      resize: vi.fn((cols: number, rows: number) => {
        instance.cols = cols;
        instance.rows = rows;
        instance.resizeCalls.push({ cols, rows });
      }),
      scrollLines: vi.fn(),
      focus: vi.fn(() => {
        instance.focusCount += 1;
      }),
      getSelection: vi.fn(() => ''),
      hasSelection: vi.fn(() => false),
      selectAll: vi.fn(),
      clearSelection: vi.fn(),
      select: vi.fn(),
      selectLines: vi.fn(),
      paste: vi.fn(),
      clear: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onBinary: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      unicode: { activeVersion: '11' },
      // Stand-in for the render service the fit path measures cells from.
      _core: {
        _renderService: {
          dimensions: {
            css: {
              get cell() {
                return instance.cellSize;
              },
            },
          },
        },
      },
    };

    (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] }).__xtermInstances.push(
      instance
    );
    return instance;
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn().mockImplementation(() => ({})),
}));
