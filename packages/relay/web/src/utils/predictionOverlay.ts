import type { Terminal } from '@xterm/xterm';

export interface PredictionOverlayStyle {
  color?: string;
  background?: string;
  underline: boolean;
  /** Colour and shape of the caret drawn where the next character will land. */
  cursor?: string;
  cursorShape?: 'block' | 'bar' | 'underline';
  /**
   * The terminal's own font. The overlay sits outside xterm's rows and would
   * otherwise inherit the page's font, which only happens to match for ASCII.
   */
  fontFamily?: string;
  fontSize?: number;
}

export interface PredictionOverlayOptions {
  getTerminal: () => Terminal | null;
  getStyle: () => PredictionOverlayStyle;
}

export interface PredictionItem {
  row: number;
  col: number;
  char: string;
  /** Cells the character covers; CJK takes two. */
  width?: 1 | 2;
  /**
   * `char` is a typed character, `erase` a cell a backspace is clearing,
   * `caret` where the caret will be once the echo arrives, and `mask` a cell
   * redrawn plainly to hide a caret the remote program painted there itself.
   */
  kind?: 'char' | 'erase' | 'caret' | 'mask';
}

type ItemKind = NonNullable<PredictionItem['kind']>;

/** Set on the terminal element while anything is predicted; see index.css. */
export const PREDICTING_CLASS = 'hr-predicting';

/**
 * Retired cells leave with xterm's next render. If none comes — nothing on
 * screen changed — they leave with the next animation frame instead. xterm
 * asks for its frame while parsing, before the overlay retires anything, so
 * in a frame where both run xterm's render comes first. A fixed timeout is
 * not used: when the page stalls, it fired before xterm had drawn the echo
 * and blanked the cells for a frame.
 */
function nextFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
}

interface CellMetrics {
  width: number;
  height: number;
}

function cellMetrics(terminal: Terminal): CellMetrics | null {
  const cell = (terminal as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
  })._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return null;
  return { width: cell.width, height: cell.height };
}

/**
 * The colours xterm is really painting: the host's palette when one was sent,
 * xterm's own defaults when not. Read from its theme service (private, read
 * only), so the overlay never names a colour of its own.
 */
function paintedColors(terminal: Terminal | null): { foreground?: string; background?: string; cursor?: string } {
  const colors = (terminal as unknown as {
    _core?: { _themeService?: { colors?: Record<string, { css?: string } | undefined> } };
  } | null)?._core?._themeService?.colors;
  return { foreground: colors?.foreground?.css, background: colors?.background?.css, cursor: colors?.cursor?.css };
}

/**
 * Draws predicted characters over the terminal until the real echo replaces
 * them.
 *
 * This is its own layer rather than a set of xterm decorations, because every
 * visible artefact came from not controlling when things are drawn:
 *
 * - xterm hides decoration elements on the alternate screen, which Herdr never
 *   leaves, and creates new ones a frame late;
 * - a confirmed prediction removed at once, while xterm repaints the echoed
 *   cell on its next frame, left one frame showing the cell's old content —
 *   a flash per keystroke, and the deleted character flashing back on
 *   backspace;
 * - a caret destroyed and recreated per keystroke blinked out for a frame;
 * - xterm's own cursor, a round trip behind, chased the text along the line.
 *
 * So cells are added the moment a key is pressed; cells that go away are only
 * retired, and leave once xterm has rendered the frame that replaces them
 * (`afterRender`, called from xterm's onRender). The caret is one element that
 * moves. And while anything is predicted, the terminal element carries
 * PREDICTING_CLASS, under which xterm's own cursor is not drawn.
 */
export class PredictionOverlay {
  private readonly options: PredictionOverlayOptions;
  private layer: HTMLDivElement | null = null;
  private owner: HTMLElement | null = null;
  private readonly cells = new Map<string, HTMLDivElement>();
  private caret: HTMLDivElement | null = null;
  private readonly retiring = new Set<HTMLElement>();
  private cancelRetireFrame: (() => void) | null = null;

  constructor(options: PredictionOverlayOptions) {
    this.options = options;
  }

  /**
   * Shows exactly `predictions`. New and changed cells appear now; cells no
   * longer listed are retired until xterm's next render.
   */
  sync(predictions: ReadonlyArray<PredictionItem>): void {
    const terminal = this.options.getTerminal();
    const layer = terminal ? this.ensureLayer(terminal) : null;
    const metrics = terminal ? cellMetrics(terminal) : null;
    if (!terminal || !layer || !metrics) {
      this.clear();
      return;
    }

    const style = this.resolveStyle();
    const viewportY = terminal.buffer?.active?.viewportY ?? 0;
    const onScreen = (row: number) => row - viewportY >= 0 && row - viewportY < terminal.rows;
    const next = new Set<string>();
    let caretItem: PredictionItem | null = null;

    for (const item of predictions) {
      const kind: ItemKind = item.kind ?? 'char';
      if (!onScreen(item.row)) continue;
      if (kind === 'caret') {
        caretItem = item;
        continue;
      }
      const key = `${item.row}:${item.col}:${kind}`;
      next.add(key);
      let element = this.cells.get(key);
      if (!element) {
        element = this.createCell(layer);
        this.cells.set(key, element);
      }
      this.retiring.delete(element);
      this.place(element, item, viewportY, metrics, style);
      this.paintCell(element, item.char, kind, item.width ?? 1, style);
    }

    for (const [key, element] of this.cells) {
      if (!next.has(key)) {
        this.cells.delete(key);
        this.retire(element);
      }
    }

    if (caretItem) {
      if (!this.caret) this.caret = this.createCell(layer);
      this.retiring.delete(this.caret);
      this.place(this.caret, caretItem, viewportY, metrics, style);
      this.paintCaret(this.caret, caretItem.char, style);
    } else if (this.caret) {
      this.retire(this.caret);
      this.caret = null;
    }

    this.updateOwnerClass();
  }

  /** xterm has rendered a frame: whatever was retired has been painted over. */
  afterRender(): void {
    this.flushRetired();
  }

  /** Wipes all predictive cells; they too leave with the next render. */
  clear(): void {
    for (const element of this.cells.values()) this.retire(element);
    this.cells.clear();
    if (this.caret) {
      this.retire(this.caret);
      this.caret = null;
    }
    this.updateOwnerClass();
  }

  /** Removes the layer outright on terminal unmount. */
  dispose(): void {
    this.cancelRetireFrame?.();
    this.cancelRetireFrame = null;
    this.cells.clear();
    this.retiring.clear();
    this.caret = null;
    this.layer?.remove();
    this.layer = null;
    this.owner?.classList.remove(PREDICTING_CLASS);
    this.owner = null;
  }

  private ensureLayer(terminal: Terminal): HTMLDivElement | null {
    const owner = terminal.element ?? null;
    const screen = owner?.querySelector<HTMLElement>('.xterm-screen');
    if (!owner || !screen) return null;
    if (this.layer && this.layer.parentElement === screen) return this.layer;
    this.layer?.remove();
    const layer = document.createElement('div');
    layer.className = 'hr-prediction-layer';
    // Above xterm's text and cursor canvases (z 0-3) and its decorations.
    Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '7' });
    screen.appendChild(layer);
    this.layer = layer;
    this.owner = owner;
    return layer;
  }

  private createCell(layer: HTMLDivElement): HTMLDivElement {
    const element = document.createElement('div');
    Object.assign(element.style, {
      position: 'absolute',
      overflow: 'hidden',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    layer.appendChild(element);
    return element;
  }

  private place(
    element: HTMLElement,
    item: PredictionItem,
    viewportY: number,
    metrics: CellMetrics,
    style: PredictionOverlayStyle,
  ): void {
    const width = item.width ?? 1;
    element.style.left = `${item.col * metrics.width}px`;
    element.style.top = `${(item.row - viewportY) * metrics.height}px`;
    element.style.width = `${width * metrics.width}px`;
    element.style.height = `${metrics.height}px`;
    element.style.lineHeight = `${metrics.height}px`;
    element.style.fontFamily = style.fontFamily ?? 'inherit';
    element.style.fontSize = style.fontSize ? `${style.fontSize}px` : 'inherit';
    // A CJK glyph is narrower than its two cells; xterm centres it, so match.
    element.style.textAlign = width === 2 ? 'center' : 'left';
  }

  private paintCell(element: HTMLElement, char: string, kind: ItemKind, _width: 1 | 2, style: PredictionOverlayStyle): void {
    element.textContent = kind === 'erase' ? ' ' : char;
    element.style.color = style.color ?? '';
    element.style.backgroundColor = style.background ?? '';
    element.style.boxShadow = 'none';
    element.style.textDecoration = kind === 'char' && style.underline ? 'underline' : 'none';
  }

  /** Mirrors the terminal's own cursor shape, as the remote program last set it. */
  private paintCaret(element: HTMLElement, char: string, style: PredictionOverlayStyle): void {
    const cursor = style.cursor ?? style.color;
    element.textContent = char;
    element.style.textDecoration = 'none';
    element.style.boxShadow = 'none';
    element.style.color = style.color ?? '';
    element.style.backgroundColor = 'transparent';
    if (!cursor) return;
    switch (style.cursorShape ?? 'block') {
      case 'bar':
        element.style.boxShadow = `inset 2px 0 0 ${cursor}`;
        break;
      case 'underline':
        element.style.boxShadow = `inset 0 -2px 0 ${cursor}`;
        break;
      default:
        element.style.backgroundColor = cursor;
        if (style.background) element.style.color = style.background;
    }
  }

  /**
   * The caller's style, with gaps filled from what xterm paints. An erased
   * cell with no background would let the old character show through, and a
   * caret with no colour is invisible.
   */
  private resolveStyle(): PredictionOverlayStyle {
    const style = this.options.getStyle();
    if (style.color && style.background && style.cursor) return style;
    const painted = paintedColors(this.options.getTerminal());
    const color = style.color ?? painted.foreground;
    return {
      ...style,
      color,
      background: style.background ?? painted.background,
      cursor: style.cursor ?? painted.cursor ?? color,
    };
  }

  private retire(element: HTMLElement): void {
    this.retiring.add(element);
    if (!this.cancelRetireFrame) {
      this.cancelRetireFrame = nextFrame(() => {
        this.cancelRetireFrame = null;
        this.flushRetired();
      });
    }
  }

  private flushRetired(): void {
    for (const element of this.retiring) element.remove();
    this.retiring.clear();
    this.cancelRetireFrame?.();
    this.cancelRetireFrame = null;
    this.updateOwnerClass();
  }

  /** xterm's cursor stays hidden for as long as any predicted cell is on screen. */
  private updateOwnerClass(): void {
    if (!this.owner) return;
    const showing = this.cells.size > 0 || this.caret !== null || this.retiring.size > 0;
    this.owner.classList.toggle(PREDICTING_CLASS, showing);
  }
}
