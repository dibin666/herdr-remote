import type { Terminal } from '@xterm/xterm';
import { CellPainter } from './cellPainter';
import type { ThemeColors } from './colors';
import { CursorBlink, type CursorState, resolveCursor } from './cursor';
import { DecorLayer } from './decorLayer';
import { createDimensions, layoutCells, watchDevicePixelSize } from './geometry';
import { overlayCellsByRow, overlayRows, type PaintOverlay } from './paintOverlay';
import { SyncHold } from './syncHold';
import {
  type Disposable,
  Emitter,
  type RenderDimensions,
  type XtermCore,
  type XtermRenderer,
  xtermCore,
} from './xtermInternals';

export interface RenderStats {
  /** Frames painted. */
  frames: number;
  /** Frames skipped because Herdr was midway through drawing one. */
  heldFrames: number;
  lastPaintMs: number;
  /** Cells repainted by the last frame. */
  lastCells: number;
  /** From the last key typed to the first frame that painted anything after it. */
  lastInputToPaintMs: number | null;
}

export interface HerdrRendererOptions {
  /** True while the host is between `?2026h` and `?2026l`; such frames are not painted. */
  isSynchronizing?: () => boolean;
  /** Longest a frame is held back waiting for its closing `?2026l`. */
  maxSyncHoldMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_SYNC_HOLD_MS = 150;

/**
 * Paints the terminal on one canvas, and only the cells that changed.
 *
 * xterm's own canvas renderer clears and redraws every row between the
 * topmost and bottommost change of a frame. Herdr changes something at the
 * top (tabs, pane titles) and the bottom (status bar, an agent's spinner)
 * nearly every frame, so that was the whole screen, on the CPU, many times a
 * second. Here each cell's words (content, colours, attributes) are compared
 * with what was last painted, and a frame costs as many cells as changed.
 *
 * It also does what xterm 5.5 does not: Herdr fences every frame in `?2026`
 * (synchronized output), and a frame that arrived in pieces is painted once,
 * whole, instead of half-drawn.
 *
 * xterm keeps parsing, input, IME, mouse reporting and selection; this
 * replaces only its drawing, installed through the render service the same
 * way xterm's canvas and WebGL addons are.
 */
export class HerdrRenderer implements XtermRenderer {
  readonly dimensions: RenderDimensions = createDimensions();
  private readonly redraw = new Emitter<{ start: number; end: number }>();
  readonly onRequestRedraw = this.redraw.event;

  readonly stats: RenderStats = {
    frames: 0,
    heldFrames: 0,
    lastPaintMs: 0,
    lastCells: 0,
    lastInputToPaintMs: null,
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly decor: DecorLayer;
  private readonly cells: CellPainter;
  private readonly disposables: Disposable[] = [];
  private readonly now: () => number;
  private readonly syncHold: SyncHold;

  private cols = 0;
  private rows = 0;

  private overlayProvider: (() => PaintOverlay | null) | null = null;
  /** Absolute rows the last painted overlay touched. */
  private paintedOverlayRows = new Set<number>();
  private paintedCursorRow = -1;
  private lastYdisp = 0;

  private inputAt: number | null = null;
  private readonly blink = new CursorBlink(() => this.requestCursorRow());
  private disposed = false;

  /**
   * Installs the renderer in place of xterm's own, or returns null when this
   * xterm does not expose what it needs. Throws if no 2D context is available.
   */
  static install(terminal: Terminal, options: HerdrRendererOptions = {}): HerdrRenderer | null {
    const core = xtermCore(terminal);
    if (!core) return null;
    const renderer = new HerdrRenderer(core, options);
    core._renderService.setRenderer(renderer);
    core._renderService.handleResize(core._bufferService.cols, core._bufferService.rows);
    return renderer;
  }

  private constructor(
    private readonly core: XtermCore,
    options: HerdrRendererOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.syncHold = new SyncHold(this.now, options.maxSyncHoldMs ?? DEFAULT_MAX_SYNC_HOLD_MS, () =>
      this.flushHeld(),
    );
    this.isSynchronizing = options.isSynchronizing ?? (() => false);
    const document = core._coreBrowserService.mainDocument;
    const screen = core.screenElement!;

    this.canvas = document.createElement('canvas');
    this.canvas.classList.add('xterm-text-layer');
    this.canvas.style.zIndex = '0';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');

    this.decor = new DecorLayer(document);

    screen.appendChild(this.canvas);
    screen.appendChild(this.decor.canvas);
    this.cells = new CellPainter(ctx, document, core, this.dimensions);

    this.disposables.push(
      core._themeService.onChangeColors(() => {
        this.cells.atlas.clear();
        this.invalidateAll();
        this.redrawDecor();
      }),
      core.optionsService.onOptionChange((option) => {
        if (option === 'cursorBlink' || option === 'cursorStyle') this.restartBlink();
      }),
    );
    if (core.linkifier) {
      this.disposables.push(
        core.linkifier.onShowLinkUnderline((event) => {
          this.decor.link = event;
          this.redrawDecor();
        }),
        core.linkifier.onHideLinkUnderline(() => {
          this.decor.link = null;
          this.redrawDecor();
        }),
      );
    }
    this.observeDevicePixels();
    this.observeFonts(document);
    this.restartBlink();
  }

  private readonly isSynchronizing: () => boolean;

  // ---------------------------------------------------------------------------
  // Overlay

  /** Where predicted cells come from; read on every frame. */
  setOverlayProvider(provider: (() => PaintOverlay | null) | null): void {
    this.overlayProvider = provider;
    this.invalidateOverlay();
  }

  /** The overlay changed: repaint the rows it touched and touches now. */
  invalidateOverlay(): void {
    const overlay = this.overlayProvider?.() ?? null;
    const rows = new Set(this.paintedOverlayRows);
    for (const row of overlayRows(overlay)) rows.add(row);
    if (this.paintedCursorRow >= 0) rows.add(this.paintedCursorRow + this.buffer().ydisp);
    this.requestAbsoluteRows(rows);
  }

  // ---------------------------------------------------------------------------
  // Sync

  /** A key was typed; the next frame that paints anything is timed against it. */
  markInput(): void {
    this.inputAt = this.now();
  }

  /** Herdr finished its frame: paint what was held back, now. */
  flushHeld(): void {
    const held = this.syncHold.pending;
    if (!held) return;
    this.redraw.fire({ start: held.start, end: held.end });
  }

  // ---------------------------------------------------------------------------
  // IRenderer

  handleDevicePixelRatioChange(): void {
    if (this.dimensions.device.cell.width && this.dprUsed !== this.core._coreBrowserService.dpr) {
      this.handleResize(this.core._bufferService.cols, this.core._bufferService.rows);
    }
  }

  handleResize(cols: number, rows: number): void {
    if (layoutCells(this.dimensions, this.core, cols, rows)) {
      this.dprUsed = this.core._coreBrowserService.dpr;
    }
    const dims = this.dimensions;
    for (const canvas of [this.canvas, this.decor.canvas]) {
      canvas.width = dims.device.canvas.width;
      canvas.height = dims.device.canvas.height;
      canvas.style.width = `${dims.css.canvas.width}px`;
      canvas.style.height = `${dims.css.canvas.height}px`;
    }
    const screen = this.core.screenElement;
    if (screen) {
      screen.style.width = `${dims.css.canvas.width}px`;
      screen.style.height = `${dims.css.canvas.height}px`;
    }
    this.cols = cols;
    this.rows = rows;
    this.cells.resize(cols, rows);
    this.paintedOverlayRows.clear();
    this.paintedCursorRow = -1;
    this.cells.configureAtlas();
    this.cells.fillBackground();
    this.redrawDecor();
  }

  handleCharSizeChanged(): void {
    this.handleResize(this.core._bufferService.cols, this.core._bufferService.rows);
  }

  handleBlur(): void {
    this.blink.stop();
    this.requestCursorRow();
    this.redrawDecor();
  }

  handleFocus(): void {
    this.restartBlink();
    this.requestCursorRow();
    this.redrawDecor();
  }

  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void {
    this.decor.setSelection(start, end, columnSelectMode);
    this.redrawDecor();
  }

  handleCursorMove(): void {
    if (this.blink.running) this.restartBlink();
  }

  clear(): void {
    this.invalidateAll();
    this.cells.fillBackground();
  }

  clearTextureAtlas(): void {
    this.cells.atlas.clear();
    this.invalidateAll();
    this.redraw.fire({ start: 0, end: Math.max(0, this.rows - 1) });
  }

  renderRows(start: number, end: number): void {
    if (this.disposed || !this.cols || !this.rows || !this.dimensions.device.cell.width) return;

    if (this.isSynchronizing() && this.syncHold.hold(start, end)) {
      this.stats.heldFrames++;
      return;
    }
    const rows = this.syncHold.release(start, end);
    this.paint(Math.max(0, rows.start), Math.min(this.rows - 1, rows.end));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.blink.stop();
    this.syncHold.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.redraw.dispose();
    this.cells.atlas.dispose();
    this.canvas.remove();
    this.decor.canvas.remove();
  }

  /** Hands drawing back to xterm's own DOM renderer. */
  uninstall(): void {
    const create = this.core._createRenderer;
    if (typeof create === 'function') {
      this.core._renderService.setRenderer(create.call(this.core));
      this.core._renderService.handleResize(
        this.core._bufferService.cols,
        this.core._bufferService.rows,
      );
    }
    this.dispose();
  }

  get textCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Whether a visible character was painted, and is still on the canvas, in
   * the cells wholly inside the top-left `width` × `height` device pixels. A
   * screen Herdr has just cleared is uniform on a perfectly good canvas; only
   * where glyphs were drawn can uniform pixels mean the surface is dead.
   */
  hasPaintedInk(width: number, height: number): boolean {
    return this.cells.hasPaintedInk(width, height);
  }

  // ---------------------------------------------------------------------------
  // Painting

  private paint(start: number, end: number): void {
    const began = this.now();
    const buffer = this.buffer();
    const ydisp = buffer.ydisp;
    if (ydisp !== this.lastYdisp) {
      this.lastYdisp = ydisp;
      this.redrawDecor();
    }

    const overlay = this.overlayProvider?.() ?? null;
    const overlayByRow = overlayCellsByRow(overlay);
    const cursor = this.cursorState(overlay);

    // Rows the overlay or the cursor left since the last frame must be
    // repainted too, whatever range xterm asked for.
    const rows = new Set<number>();
    for (let y = start; y <= end; y++) rows.add(y);
    for (const row of this.paintedOverlayRows) addViewportRow(rows, row - ydisp, this.rows);
    for (const row of overlayByRow.keys()) addViewportRow(rows, row - ydisp, this.rows);
    if (this.paintedCursorRow >= 0) addViewportRow(rows, this.paintedCursorRow, this.rows);
    if (cursor) addViewportRow(rows, cursor.y, this.rows);

    let cells = 0;
    for (const y of rows) {
      this.cells.loadRow(buffer.lines.get(ydisp + y), overlayByRow.get(y + ydisp));
      cells += this.cells.paintRow(y, cursor);
    }

    this.paintedOverlayRows = new Set(overlayByRow.keys());
    this.paintedCursorRow = cursor ? cursor.y : -1;
    this.stats.frames++;
    this.stats.lastCells = cells;
    this.stats.lastPaintMs = this.now() - began;
    if (this.inputAt !== null && cells > 0) {
      this.stats.lastInputToPaintMs = this.now() - this.inputAt;
      this.inputAt = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor

  private cursorState(overlay: PaintOverlay | null): CursorState | null {
    return resolveCursor(
      this.core,
      this.buffer(),
      overlay,
      { rows: this.rows, cols: this.cols },
      this.blink.hidden,
    );
  }

  private restartBlink(): void {
    this.blink.stop();
    if (
      this.disposed ||
      !this.core.optionsService.rawOptions.cursorBlink ||
      !this.core._coreBrowserService.isFocused
    ) {
      this.requestCursorRow();
      return;
    }
    this.blink.start();
    this.requestCursorRow();
  }

  private requestCursorRow(): void {
    if (!this.rows) return;
    const buffer = this.buffer();
    const rows = new Set<number>();
    rows.add(buffer.ybase + buffer.y);
    if (this.paintedCursorRow >= 0) rows.add(this.paintedCursorRow + buffer.ydisp);
    this.requestAbsoluteRows(rows);
  }

  // ---------------------------------------------------------------------------
  // Selection and link underline, on their own layer

  private redrawDecor(): void {
    this.decor.paint({
      dims: this.dimensions.device,
      rows: this.rows,
      cols: this.cols,
      ydisp: this.buffer().ydisp,
      colors: this.colors(),
      focused: this.core._coreBrowserService.isFocused,
      dpr: this.core._coreBrowserService.dpr,
    });
  }

  // ---------------------------------------------------------------------------
  // Geometry

  private dprUsed = 0;

  /** Everything painted is forgotten; the next frame repaints every cell it is asked for. */
  private invalidateAll(): void {
    this.cells.invalidate();
    this.paintedCursorRow = -1;
  }

  /** Adopts the canvas's exact size in device pixels; see watchDevicePixelSize. */
  private observeDevicePixels(): void {
    const watch = watchDevicePixelSize(
      this.core._coreBrowserService.window,
      this.canvas,
      (width, height) => {
        // A rounding correction is a pixel or two. Anything else is a size the
        // cells were not laid out for (emulated device scales report CSS pixels
        // here), and drawing into it would scale the whole grid.
        const dpr = this.core._coreBrowserService.dpr;
        const css = this.dimensions.css.canvas;
        if (Math.abs(width - css.width * dpr) > 2 || Math.abs(height - css.height * dpr) > 2)
          return;
        this.dimensions.device.canvas.width = width;
        this.dimensions.device.canvas.height = height;
        for (const canvas of [this.canvas, this.decor.canvas]) {
          canvas.width = width;
          canvas.height = height;
        }
        this.invalidateAll();
        this.cells.fillBackground();
        this.redrawDecor();
        this.redraw.fire({ start: 0, end: Math.max(0, this.rows - 1) });
      },
    );
    if (watch) this.disposables.push(watch);
  }

  /** A web font that finishes loading changes glyphs already cached with its fallback. */
  private observeFonts(document: Document): void {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts || typeof fonts.addEventListener !== 'function') return;
    const onLoaded = () => this.clearTextureAtlas();
    fonts.addEventListener('loadingdone', onLoaded);
    this.disposables.push({ dispose: () => fonts.removeEventListener('loadingdone', onLoaded) });
  }

  // ---------------------------------------------------------------------------

  private buffer() {
    return this.core._bufferService.buffer;
  }

  private colors(): ThemeColors {
    return this.core._themeService.colors;
  }

  private requestAbsoluteRows(rows: Iterable<number>): void {
    if (!this.rows) return;
    const ydisp = this.buffer().ydisp;
    let start = Infinity;
    let end = -Infinity;
    for (const row of rows) {
      const y = row - ydisp;
      if (y < 0 || y >= this.rows) continue;
      start = Math.min(start, y);
      end = Math.max(end, y);
    }
    if (start <= end) this.redraw.fire({ start, end });
  }
}

function addViewportRow(rows: Set<number>, y: number, count: number): void {
  if (y >= 0 && y < count) rows.add(y);
}
