import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { PredictionOverlay, PREDICTING_CLASS, type PredictionOverlayStyle } from '../utils/predictionOverlay';

/**
 * A terminal as far as the overlay can see it: the `.xterm` element holding a
 * `.xterm-screen`, the viewport position, and the cell size xterm measured.
 */
function createTerminal(options: { viewportY?: number; rows?: number; theme?: Record<string, string> } = {}) {
  const element = document.createElement('div');
  element.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  element.appendChild(screen);
  document.body.appendChild(element);
  const terminal = {
    element,
    rows: options.rows ?? 24,
    buffer: { active: { viewportY: options.viewportY ?? 0 } },
    _core: {
      _renderService: { dimensions: { css: { cell: { width: 9, height: 18 } } } },
      _themeService: options.theme
        ? { colors: Object.fromEntries(Object.entries(options.theme).map(([k, css]) => [k, { css }])) }
        : undefined,
    },
  };
  return { terminal: terminal as unknown as Terminal, element, screen };
}

function createOverlay(terminal: Terminal, style: Partial<PredictionOverlayStyle> = {}) {
  return new PredictionOverlay({
    getTerminal: () => terminal,
    getStyle: () => ({ color: '#eeeeee', background: '#101010', cursor: '#ff0000', underline: false, ...style }),
  });
}

const cellsIn = (screen: HTMLElement) =>
  [...screen.querySelectorAll<HTMLElement>('.hr-prediction-layer > div')];

describe('PredictionOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('draws each predicted character in its cell, in the terminal font', () => {
    const { terminal, screen } = createTerminal();
    const overlay = createOverlay(terminal, { fontFamily: 'JetBrains Mono', fontSize: 15 });
    overlay.sync([
      { row: 3, col: 5, char: 'a' },
      { row: 3, col: 6, char: '你', width: 2 },
    ]);
    const [a, wide] = cellsIn(screen);
    expect(a.textContent).toBe('a');
    expect([a.style.left, a.style.top, a.style.width, a.style.height]).toEqual(['45px', '54px', '9px', '18px']);
    expect(a.style.fontFamily).toContain('JetBrains Mono');
    expect(a.style.fontSize).toBe('15px');
    expect(a.style.lineHeight).toBe('18px');
    // A CJK glyph spans two cells and is centred in them, as xterm draws it.
    expect(wide.style.width).toBe('18px');
    expect(wide.style.textAlign).toBe('center');
  });

  it('sits above xterm’s canvases and never takes a pointer event', () => {
    const { terminal, screen } = createTerminal();
    createOverlay(terminal).sync([{ row: 0, col: 0, char: 'a' }]);
    const layer = screen.querySelector<HTMLElement>('.hr-prediction-layer')!;
    expect(Number(layer.style.zIndex)).toBeGreaterThan(3);
    expect(layer.style.pointerEvents).toBe('none');
  });

  it('keeps a cell that stopped being predicted until xterm has drawn the frame that replaces it', () => {
    // Removing it at once left a frame with the cell's old content showing:
    // the flash on every echoed key, and the deleted character on backspace.
    const { terminal, screen } = createTerminal();
    const overlay = createOverlay(terminal);
    overlay.sync([
      { row: 0, col: 0, char: 'a' },
      { row: 0, col: 1, char: 'b' },
    ]);
    overlay.sync([{ row: 0, col: 1, char: 'b' }]);
    expect(cellsIn(screen).map((cell) => cell.textContent)).toEqual(['a', 'b']);
    overlay.afterRender();
    expect(cellsIn(screen).map((cell) => cell.textContent)).toEqual(['b']);
  });

  it('removes retired cells with the next frame if xterm has nothing to render', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      const { terminal, screen } = createTerminal();
      const overlay = createOverlay(terminal);
      overlay.sync([{ row: 0, col: 0, char: 'a' }]);
      overlay.sync([]);
      // No timer takes it away early: a stalled page used to lose it before xterm drew the echo.
      vi.advanceTimersByTime(500);
      expect(cellsIn(screen)).toHaveLength(1);
      frames.splice(0).forEach((callback) => callback(0));
      expect(cellsIn(screen)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('moves one caret element instead of recreating it on every key', () => {
    const { terminal, screen } = createTerminal();
    const overlay = createOverlay(terminal);
    overlay.sync([{ row: 0, col: 0, char: 'a' }, { row: 0, col: 1, char: ' ', kind: 'caret' }]);
    const caret = cellsIn(screen).find((cell) => cell.style.left === '9px')!;
    overlay.sync([
      { row: 0, col: 0, char: 'a' },
      { row: 0, col: 1, char: 'b' },
      { row: 0, col: 2, char: ' ', kind: 'caret' },
    ]);
    expect(caret.isConnected).toBe(true);
    expect(caret.style.left).toBe('18px');
  });

  it('hides xterm’s own cursor while anything predicted is on screen', () => {
    const { terminal, element } = createTerminal();
    const overlay = createOverlay(terminal);
    overlay.sync([{ row: 0, col: 0, char: 'a' }, { row: 0, col: 1, char: ' ', kind: 'caret' }]);
    expect(element.classList.contains(PREDICTING_CLASS)).toBe(true);

    // Still hidden until the frame with the echo is drawn, so the real cursor
    // never shows up at the old position in between.
    overlay.sync([]);
    expect(element.classList.contains(PREDICTING_CLASS)).toBe(true);
    overlay.afterRender();
    expect(element.classList.contains(PREDICTING_CLASS)).toBe(false);
  });

  it('underlines predicted characters only, and paints erased and masked cells opaque', () => {
    const { terminal, screen } = createTerminal();
    const overlay = createOverlay(terminal, { underline: true });
    overlay.sync([
      { row: 0, col: 0, char: 'a' },
      { row: 0, col: 1, char: ' ', kind: 'erase' },
      { row: 0, col: 2, char: 'x', kind: 'mask' },
    ]);
    const [typed, erased, masked] = cellsIn(screen);
    expect(typed.style.textDecoration).toBe('underline');
    expect(erased.style.textDecoration).toBe('none');
    expect(erased.textContent).toBe(' ');
    expect(erased.style.backgroundColor).toBe('rgb(16, 16, 16)');
    expect(masked.textContent).toBe('x');
    expect(masked.style.textDecoration).toBe('none');
    expect(masked.style.backgroundColor).toBe('rgb(16, 16, 16)');
  });

  it('draws the caret in the cursor colour and the shape the pane asked for', () => {
    const { terminal, screen } = createTerminal();
    let shape: 'block' | 'bar' = 'block';
    const overlay = new PredictionOverlay({
      getTerminal: () => terminal,
      getStyle: () => ({ color: '#eeeeee', background: '#101010', cursor: '#ff0000', cursorShape: shape, underline: false }),
    });
    overlay.sync([{ row: 0, col: 3, char: 'x', kind: 'caret' }]);
    const [caret] = cellsIn(screen);
    expect(caret.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(caret.style.color).toBe('rgb(16, 16, 16)');
    expect(caret.textContent).toBe('x');

    shape = 'bar';
    overlay.sync([{ row: 0, col: 3, char: 'x', kind: 'caret' }]);
    expect(caret.style.backgroundColor).toBe('transparent');
    expect(caret.style.boxShadow).toContain('inset 2px 0 0');
  });

  it('falls back to the colours xterm is painting when the host sent no palette', () => {
    const { terminal, screen } = createTerminal({ theme: { foreground: '#d0d0d0', background: '#0a0a0a', cursor: '#ff00ff' } });
    const overlay = new PredictionOverlay({ getTerminal: () => terminal, getStyle: () => ({ underline: false }) });
    overlay.sync([
      { row: 0, col: 0, char: ' ', kind: 'erase' },
      { row: 0, col: 1, char: ' ', kind: 'caret' },
    ]);
    const [erased, caret] = cellsIn(screen);
    // An erased cell must be opaque, or the old character shows through.
    expect(erased.style.backgroundColor).toBe('rgb(10, 10, 10)');
    expect(caret.style.backgroundColor).toBe('rgb(255, 0, 255)');
  });

  it('places rows relative to the viewport and skips rows scrolled out of it', () => {
    const { terminal, screen } = createTerminal({ viewportY: 10, rows: 5 });
    const overlay = createOverlay(terminal);
    overlay.sync([
      { row: 12, col: 0, char: 'a' },
      { row: 3, col: 0, char: 'b' },
    ]);
    const cells = cellsIn(screen);
    expect(cells.map((cell) => cell.textContent)).toEqual(['a']);
    expect(cells[0].style.top).toBe('36px');
  });

  it('draws nothing, and throws nothing, before xterm has a screen or cell size', () => {
    const bare = { rows: 24, buffer: { active: { viewportY: 0 } } } as unknown as Terminal;
    const overlay = createOverlay(bare);
    expect(() => overlay.sync([{ row: 0, col: 0, char: 'a' }])).not.toThrow();
  });

  it('takes its layer and the cursor class away on dispose', () => {
    const { terminal, element, screen } = createTerminal();
    const overlay = createOverlay(terminal);
    overlay.sync([{ row: 0, col: 0, char: 'a' }]);
    overlay.dispose();
    expect(screen.querySelector('.hr-prediction-layer')).toBeNull();
    expect(element.classList.contains(PREDICTING_CLASS)).toBe(false);
  });
});
