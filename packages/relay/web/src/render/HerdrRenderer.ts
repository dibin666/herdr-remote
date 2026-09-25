import type { Terminal } from '@xterm/xterm';
import {
  BgFlags,
  Content,
  FgFlags,
  UnderlineStyle,
  cellExt,
  contentFor,
  createRawCell,
  underlineColorOf,
  underlineStyleOf,
  type CellStyle,
} from './cell';
import {
  colorWordCss,
  isBold,
  isDim,
  isInvisible,
  isItalic,
  resolveCellColors,
  type ThemeColors,
} from './colors';
import { DIM_OPACITY, GlyphAtlas, isCustomGlyph } from './glyphAtlas';
import {
  xtermCore,
  type Disposable,
  type LinkEvent,
  type RenderDimensions,
  type XtermCore,
  type XtermRenderer,
} from './xtermInternals';

/**
 * A cell drawn in place of what the buffer holds, for as long as it is
 * listed. Predicted typing is drawn this way: through the same glyphs and
 * colours as the echo that will replace it, so the swap paints nothing.
 */
export interface OverlayCell {
  /** Absolute buffer row. */
  row: number;
  col: number;
  chars: string;
  width: 1 | 2;
  style: CellStyle;
}

export interface PaintOverlay {
  cells: ReadonlyArray<OverlayCell>;
  /**
   * Where the terminal cursor is drawn instead of the buffer's cursor
   * (absolute row); `null` hides it. Absent, the buffer's cursor is drawn.
   */
  cursor?: { row: number; col: number } | null;
}

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
const BLINK_INTERVAL_MS = 600;
const INVALID = 0xffffffff;

const enum CursorShape {
  NONE = 0,
  BLOCK = 1,
  BAR = 2,
  UNDERLINE = 3,
  OUTLINE = 4,
}

const enum Meta {
  CELLS_MASK = 0x3,
  COVERED = 0x4,
  CURSOR_SHIFT = 3,
}

interface CursorState {
  /** Viewport row. */
  y: number;
  x: number;
  shape: CursorShape;
}

function createDimensions(): RenderDimensions {
  return {
    css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
    device: {
      canvas: { width: 0, height: 0 },
      cell: { width: 0, height: 0 },
      char: { width: 0, height: 0, left: 0, top: 0 },
    },
  };
}

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

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
  private readonly ctx: CanvasRenderingContext2D;
  private readonly decorCanvas: HTMLCanvasElement;
  private readonly decorCtx: CanvasRenderingContext2D;
  private readonly atlas: GlyphAtlas;
  private readonly disposables: Disposable[] = [];
  private readonly now: () => number;
  private readonly maxSyncHoldMs: number;

  private cols = 0;
  private rows = 0;
  private painted = {
    content: new Uint32Array(0),
    fg: new Uint32Array(0),
    bg: new Uint32Array(0),
    ext: new Uint32Array(0),
    meta: new Uint32Array(0),
    combined: [] as string[],
  };
  private row = {
    content: new Uint32Array(0),
    fg: new Uint32Array(0),
    bg: new Uint32Array(0),
    ext: new Uint32Array(0),
    combined: [] as string[],
  };
  private readonly work = createRawCell();

  private overlayProvider: (() => PaintOverlay | null) | null = null;
  /** Absolute rows the last painted overlay touched. */
  private paintedOverlayRows = new Set<number>();
  private paintedCursorRow = -1;
  private lastYdisp = 0;

  private holdStartedAt: number | null = null;
  private held: { start: number; end: number } | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  private selection: {
    start: [number, number];
    end: [number, number];
    columnSelectMode: boolean;
  } | null = null;
  private link: LinkEvent | null = null;

  private inputAt: number | null = null;
  private blinkVisible = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
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
    this.maxSyncHoldMs = options.maxSyncHoldMs ?? DEFAULT_MAX_SYNC_HOLD_MS;
    this.isSynchronizing = options.isSynchronizing ?? (() => false);
    const document = core._coreBrowserService.mainDocument;
    const screen = core.screenElement!;

    this.canvas = document.createElement('canvas');
    this.canvas.classList.add('xterm-text-layer');
    this.canvas.style.zIndex = '0';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;

    this.decorCanvas = document.createElement('canvas');
    this.decorCanvas.classList.add('xterm-decor-layer');
    this.decorCanvas.style.zIndex = '2';
    const decorCtx = this.decorCanvas.getContext('2d');
    if (!decorCtx) throw new Error('2D canvas unavailable');
    this.decorCtx = decorCtx;

    screen.appendChild(this.canvas);
    screen.appendChild(this.decorCanvas);
    this.atlas = new GlyphAtlas(document);

    this.disposables.push(
      core._themeService.onChangeColors(() => {
        this.atlas.clear();
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
          this.link = event;
          this.redrawDecor();
        }),
        core.linkifier.onHideLinkUnderline(() => {
          this.link = null;
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
    if (!this.held) return;
    const { start, end } = this.held;
    this.redraw.fire({ start, end });
  }

  // ---------------------------------------------------------------------------
  // IRenderer

  handleDevicePixelRatioChange(): void {
    if (this.dimensions.device.cell.width && this.dprUsed !== this.core._coreBrowserService.dpr) {
      this.handleResize(this.core._bufferService.cols, this.core._bufferService.rows);
    }
  }

  handleResize(cols: number, rows: number): void {
    this.updateDimensions(cols, rows);
    const dims = this.dimensions;
    for (const canvas of [this.canvas, this.decorCanvas]) {
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
    this.resizeGrid(cols, rows);
    this.configureAtlas();
    this.fillBackground();
    this.redrawDecor();
  }

  handleCharSizeChanged(): void {
    this.handleResize(this.core._bufferService.cols, this.core._bufferService.rows);
  }

  handleBlur(): void {
    this.stopBlink();
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
    this.selection =
      start && end && !(start[0] === end[0] && start[1] === end[1])
        ? { start: [start[0], start[1]], end: [end[0], end[1]], columnSelectMode }
        : null;
    this.redrawDecor();
  }

  handleCursorMove(): void {
    if (this.blinkTimer) this.restartBlink();
  }

  clear(): void {
    this.invalidateAll();
    this.fillBackground();
  }

  clearTextureAtlas(): void {
    this.atlas.clear();
    this.invalidateAll();
    this.redraw.fire({ start: 0, end: Math.max(0, this.rows - 1) });
  }

  renderRows(start: number, end: number): void {
    if (this.disposed || !this.cols || !this.rows || !this.dimensions.device.cell.width) return;

    if (this.isSynchronizing()) {
      const now = this.now();
      if (this.holdStartedAt === null) this.holdStartedAt = now;
      if (now - this.holdStartedAt < this.maxSyncHoldMs) {
        this.held = this.held
          ? { start: Math.min(this.held.start, start), end: Math.max(this.held.end, end) }
          : { start, end };
        this.stats.heldFrames++;
        if (!this.holdTimer) {
          this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            this.flushHeld();
          }, this.maxSyncHoldMs);
        }
        return;
      }
    }
    if (this.held) {
      start = Math.min(start, this.held.start);
      end = Math.max(end, this.held.end);
    }
    this.held = null;
    this.holdStartedAt = null;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.paint(Math.max(0, start), Math.min(this.rows - 1, end));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopBlink();
    if (this.holdTimer) clearTimeout(this.holdTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.redraw.dispose();
    this.atlas.dispose();
    this.canvas.remove();
    this.decorCanvas.remove();
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
    const dims = this.dimensions.device;
    if (!dims.cell.width || !dims.cell.height) return false;
    const cols = Math.min(this.cols, Math.floor(width / dims.cell.width));
    const rows = Math.min(this.rows, Math.floor(height / dims.cell.height));
    const painted = this.painted;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * this.cols + x;
        const word = painted.content[i];
        if (word === INVALID || painted.meta[i] === Meta.COVERED || isInvisible(painted.fg[i]))
          continue;
        const code = word & Content.CODEPOINT_MASK;
        if (
          word & Content.IS_COMBINED_MASK ? painted.combined[i] !== '' : code !== 0 && code !== 32
        )
          return true;
      }
    }
    return false;
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
    const overlayByRow = new Map<number, OverlayCell[]>();
    for (const cell of overlay?.cells ?? []) {
      const list = overlayByRow.get(cell.row);
      if (list) list.push(cell);
      else overlayByRow.set(cell.row, [cell]);
    }
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
      this.loadRow(y, ydisp, overlayByRow.get(y + ydisp));
      cells += this.paintRow(y, cursor);
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

  /** Reads one viewport row into the scratch arrays, with overlay cells laid over it. */
  private loadRow(y: number, ydisp: number, overlay: OverlayCell[] | undefined): void {
    const { content, fg, bg, ext, combined } = this.row;
    const line = this.buffer().lines.get(ydisp + y);
    const work = this.work;
    for (let x = 0; x < this.cols; x++) {
      if (line && x < line.length) {
        line.loadCell(x, work);
        content[x] = work.content;
        fg[x] = work.fg;
        bg[x] = work.bg;
        ext[x] = cellExt(work);
        combined[x] = work.content & Content.IS_COMBINED_MASK ? work.combinedData : '';
      } else {
        content[x] = 1 << Content.WIDTH_SHIFT;
        fg[x] = 0;
        bg[x] = 0;
        ext[x] = 0;
        combined[x] = '';
      }
    }
    if (!overlay) return;
    for (const cell of overlay) {
      const x = cell.col;
      if (x < 0 || x + cell.width > this.cols) continue;
      // Writing over either half of a wide character erases the whole of it.
      if (x > 0 && content[x] >>> Content.WIDTH_SHIFT === 0) this.blankAt(x - 1);
      const end = x + cell.width;
      if (
        end < this.cols &&
        content[end] >>> Content.WIDTH_SHIFT === 0 &&
        content[end - 1] >>> Content.WIDTH_SHIFT === 2
      ) {
        this.blankAt(end);
      }
      const packed = contentFor(cell.chars, cell.width);
      content[x] = packed.content;
      combined[x] = packed.combinedData;
      fg[x] = cell.style.fg;
      bg[x] = cell.style.bg;
      ext[x] = cell.style.ext;
      if (cell.width === 2) {
        content[x + 1] = 0;
        combined[x + 1] = '';
        fg[x + 1] = cell.style.fg;
        bg[x + 1] = cell.style.bg;
        ext[x + 1] = cell.style.ext;
      }
    }
  }

  private blankAt(x: number): void {
    this.row.content[x] = 32 | (1 << Content.WIDTH_SHIFT);
    this.row.combined[x] = '';
  }

  /** Compares one row against what was painted and repaints what differs. Returns cells painted. */
  private paintRow(y: number, cursor: CursorState | null): number {
    const cols = this.cols;
    const { content, fg, bg, ext, combined } = this.row;
    const painted = this.painted;
    const base = y * cols;
    let repainted = 0;
    let fillStart = -1;
    let fillEnd = -1;
    let fillCss = '';

    const flushFill = () => {
      if (fillStart < 0) return;
      this.fillCells(fillStart, y, fillEnd - fillStart, fillCss);
      fillStart = -1;
    };

    let x = 0;
    while (x < cols) {
      const word = content[x];
      let cells = word >>> Content.WIDTH_SHIFT;
      if (cells === 0) cells = 1;
      if (x + cells > cols) cells = cols - x;
      if (cells === 1 && x + 1 < cols && this.overflowsInto(x)) cells = 2;

      const cursorShape =
        cursor && cursor.y === y && cursor.x >= x && cursor.x < x + cells
          ? cursor.shape
          : CursorShape.NONE;
      const meta = cells | (cursorShape << Meta.CURSOR_SHIFT);

      let dirty = this.differs(base + x, x, meta);
      for (let c = 1; c < cells; c++) {
        if (this.differs(base + x + c, x + c, Meta.COVERED)) dirty = true;
      }

      if (dirty) {
        for (let c = 0; c < cells; c++) {
          const i = base + x + c;
          painted.content[i] = content[x + c];
          painted.fg[i] = fg[x + c];
          painted.bg[i] = bg[x + c];
          painted.ext[i] = ext[x + c];
          painted.meta[i] = c === 0 ? meta : Meta.COVERED;
          painted.combined[i] = combined[x + c];
        }
        repainted += cells;
        const plain = this.plainFill(x, cursorShape);
        if (plain !== null) {
          if (fillStart >= 0 && fillEnd === x && fillCss === plain) {
            fillEnd = x + cells;
          } else {
            flushFill();
            fillStart = x;
            fillEnd = x + cells;
            fillCss = plain;
          }
        } else {
          flushFill();
          this.paintCell(x, y, cells, cursorShape);
        }
      }
      x += cells;
    }
    flushFill();
    return repainted;
  }

  private differs(i: number, x: number, meta: number): boolean {
    const painted = this.painted;
    const row = this.row;
    return (
      painted.meta[i] !== meta ||
      painted.content[i] !== row.content[x] ||
      painted.fg[i] !== row.fg[x] ||
      painted.bg[i] !== row.bg[x] ||
      painted.ext[i] !== row.ext[x] ||
      painted.combined[i] !== row.combined[x]
    );
  }

  /**
   * A symbol drawn wider than its cell (Claude's `⏺`, say) keeps the ink
   * that spills into the next cell when that cell is blank on the same
   * background, as terminals do; otherwise it is clipped to its own.
   */
  private overflowsInto(x: number): boolean {
    const { content, fg, bg, ext } = this.row;
    const word = content[x];
    const code = word & Content.CODEPOINT_MASK;
    if (code < 0x80 && !(word & Content.IS_COMBINED_MASK)) return false;
    if (word >>> Content.WIDTH_SHIFT !== 1 || isInvisible(fg[x])) return false;
    const next = content[x + 1];
    const nextCode = next & Content.CODEPOINT_MASK;
    if (
      next >>> Content.WIDTH_SHIFT !== 1 ||
      next & Content.IS_COMBINED_MASK ||
      (nextCode !== 0 && nextCode !== 32)
    )
      return false;
    if (
      bg[x] !== bg[x + 1] ||
      ext[x + 1] !== 0 ||
      (fg[x] & FgFlags.INVERSE) !== (fg[x + 1] & FgFlags.INVERSE)
    )
      return false;
    if (fg[x] & FgFlags.INVERSE && fg[x] !== fg[x + 1]) return false;
    if (fg[x + 1] & (FgFlags.UNDERLINE | FgFlags.STRIKETHROUGH) || bg[x + 1] & BgFlags.OVERLINE)
      return false;
    const chars = this.charsAt(x);
    if (this.core.optionsService.rawOptions.customGlyphs !== false && isCustomGlyph(chars))
      return false;
    return this.atlas.overflow(chars, isBold(fg[x]), isItalic(bg[x])) > 0;
  }

  private charsAt(x: number): string {
    const word = this.row.content[x];
    if (word & Content.IS_COMBINED_MASK) return this.row.combined[x];
    const code = word & Content.CODEPOINT_MASK;
    return code ? String.fromCodePoint(code) : '';
  }

  /** The css to fill a cell with, when a plain fill is all it needs; null otherwise. */
  private plainFill(x: number, cursorShape: CursorShape): string | null {
    if (cursorShape !== CursorShape.NONE) return null;
    const { content, fg, bg } = this.row;
    const word = content[x];
    const code = word & Content.CODEPOINT_MASK;
    const blank = !(word & Content.IS_COMBINED_MASK) && (code === 0 || code === 32);
    const invisible = isInvisible(fg[x]);
    if (!blank && !invisible) return null;
    const decorated =
      fg[x] & (FgFlags.UNDERLINE | FgFlags.STRIKETHROUGH) || bg[x] & BgFlags.OVERLINE;
    if (decorated && !invisible) return null;
    return resolveCellColors(fg[x], bg[x], this.colors(), this.boldBright()).bg;
  }

  private paintCell(x: number, y: number, cells: number, cursorShape: CursorShape): void {
    const ctx = this.ctx;
    const dims = this.dimensions.device;
    const colors = this.colors();
    const fgWord = this.row.fg[x];
    const bgWord = this.row.bg[x];
    const ext = this.row.ext[x];
    const resolved = resolveCellColors(fgWord, bgWord, colors, this.boldBright());
    let fgCss = resolved.fg;
    let bgCss = resolved.bg;
    if (cursorShape === CursorShape.BLOCK) {
      bgCss = colors.cursor.css;
      fgCss = colors.cursorAccent.css;
    }
    const invisible = isInvisible(fgWord);
    const chars = this.charsAt(x);
    const px = x * dims.cell.width;
    const py = y * dims.cell.height;
    const width = cells * dims.cell.width;
    const height = dims.cell.height;

    const blank = invisible || chars === '' || chars === ' ';
    const slot = blank
      ? null
      : this.atlas.get({
          chars,
          bold: isBold(fgWord),
          italic: isItalic(bgWord),
          dim: isDim(bgWord),
          fg: fgCss,
          bg: bgCss,
          cells,
        });
    if (slot) {
      ctx.drawImage(slot.source, slot.x, slot.y, slot.width, slot.height, px, py, width, height);
    } else {
      ctx.fillStyle = bgCss;
      ctx.fillRect(px, py, width, height);
      if (!blank) {
        // No atlas room: draw the glyph directly.
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, width, height);
        ctx.clip();
        ctx.fillStyle = fgCss;
        if (isDim(bgWord)) ctx.globalAlpha = DIM_OPACITY;
        ctx.font = this.atlas.fontString(isBold(fgWord), isItalic(bgWord));
        ctx.fillText(chars, px + dims.char.left, py + dims.char.top + dims.char.height);
        ctx.restore();
      }
    }

    if (!invisible) this.paintDecorations(px, py, cells, fgWord, bgWord, ext, fgCss);
    if (cursorShape !== CursorShape.NONE && cursorShape !== CursorShape.BLOCK) {
      this.paintCursorShape(px, py, width, cursorShape);
    }
  }

  private paintDecorations(
    px: number,
    py: number,
    cells: number,
    fgWord: number,
    bgWord: number,
    ext: number,
    fgCss: string,
  ): void {
    const underline = (fgWord & FgFlags.UNDERLINE) !== 0;
    const strike = (fgWord & FgFlags.STRIKETHROUGH) !== 0;
    const overline = (bgWord & BgFlags.OVERLINE) !== 0;
    if (!underline && !strike && !overline) return;
    const ctx = this.ctx;
    const dims = this.dimensions.device;
    const options = this.core.optionsService.rawOptions;
    const dpr = this.core._coreBrowserService.dpr;
    const width = cells * dims.cell.width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, width, dims.cell.height);
    ctx.clip();
    if (isDim(bgWord)) ctx.globalAlpha = DIM_OPACITY;

    const lineWidth = Math.max(1, Math.floor((options.fontSize * dpr) / 15));
    const half = lineWidth % 2 === 1 ? 0.5 : 0;
    if (underline) {
      const colorWord = underlineColorOf(ext);
      let stroke = fgCss;
      if (colorWord) {
        let word = colorWord;
        if (
          this.boldBright() &&
          isBold(fgWord) &&
          (word & 0x3000000) !== 0x3000000 &&
          (word & 0xff) < 8
        )
          word += 8;
        stroke = colorWordCss(word, this.colors(), fgCss);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      const top = py + dims.char.top + Math.ceil(dims.char.height) - half - lineWidth * 2;
      const style = ext ? underlineStyleOf(ext) : UnderlineStyle.SINGLE;
      ctx.beginPath();
      switch (style) {
        case UnderlineStyle.DOUBLE:
          ctx.moveTo(px, top);
          ctx.lineTo(px + width, top);
          ctx.moveTo(px, top + lineWidth * 2);
          ctx.lineTo(px + width, top + lineWidth * 2);
          break;
        case UnderlineStyle.CURLY: {
          const mid = top + lineWidth;
          const amp = Math.max(1, lineWidth);
          for (let c = 0; c < cells; c++) {
            const left = px + c * dims.cell.width;
            const center = left + dims.cell.width / 2;
            const right = left + dims.cell.width;
            ctx.moveTo(left, mid);
            ctx.bezierCurveTo(left, mid - amp, center, mid - amp, center, mid);
            ctx.bezierCurveTo(center, mid + amp, right, mid + amp, right, mid);
          }
          break;
        }
        case UnderlineStyle.DOTTED:
          ctx.setLineDash([lineWidth, lineWidth]);
          ctx.moveTo(px, top);
          ctx.lineTo(px + width, top);
          break;
        case UnderlineStyle.DASHED: {
          const line = Math.floor(0.6 * dims.cell.width);
          const gap = Math.floor(0.3 * dims.cell.width);
          ctx.setLineDash([line, gap, dims.cell.width - line - gap]);
          ctx.moveTo(px, top);
          ctx.lineTo(px + width, top);
          break;
        }
        default:
          ctx.moveTo(px, top);
          ctx.lineTo(px + width, top);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (overline) {
      ctx.strokeStyle = fgCss;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(px, py + dims.char.top + half);
      ctx.lineTo(px + width, py + dims.char.top + half);
      ctx.stroke();
    }
    if (strike) {
      const strikeWidth = Math.max(1, Math.floor((options.fontSize * dpr) / 10));
      const mid =
        py + dims.char.top + Math.floor(dims.char.height / 2) - (strikeWidth % 2 === 1 ? 0.5 : 0);
      ctx.strokeStyle = fgCss;
      ctx.lineWidth = strikeWidth;
      ctx.beginPath();
      ctx.moveTo(px, mid);
      ctx.lineTo(px + width, mid);
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintCursorShape(px: number, py: number, width: number, shape: CursorShape): void {
    const ctx = this.ctx;
    const dims = this.dimensions.device;
    const dpr = this.core._coreBrowserService.dpr;
    const colors = this.colors();
    ctx.save();
    ctx.fillStyle = colors.cursor.css;
    ctx.strokeStyle = colors.cursor.css;
    switch (shape) {
      case CursorShape.BAR:
        ctx.fillRect(
          px,
          py,
          Math.max(1, Math.round(this.core.optionsService.rawOptions.cursorWidth * dpr)),
          dims.cell.height,
        );
        break;
      case CursorShape.UNDERLINE:
        ctx.fillRect(
          px,
          py + dims.cell.height - Math.max(1, Math.round(dpr)) - 1,
          width,
          Math.max(1, Math.round(dpr)),
        );
        break;
      case CursorShape.OUTLINE: {
        const line = Math.max(1, Math.round(dpr));
        ctx.lineWidth = line;
        ctx.strokeRect(px + line / 2, py + line / 2, width - line, dims.cell.height - line);
        break;
      }
    }
    ctx.restore();
  }

  private fillCells(x: number, y: number, cells: number, css: string): void {
    const dims = this.dimensions.device;
    this.ctx.fillStyle = css;
    this.ctx.fillRect(
      x * dims.cell.width,
      y * dims.cell.height,
      cells * dims.cell.width,
      dims.cell.height,
    );
  }

  private fillBackground(): void {
    this.ctx.fillStyle = this.colors().background.css;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---------------------------------------------------------------------------
  // Cursor

  private cursorState(overlay: PaintOverlay | null): CursorState | null {
    const core = this.core;
    const buffer = this.buffer();
    let row: number;
    let col: number;
    if (overlay && overlay.cursor !== undefined) {
      if (overlay.cursor === null) return null;
      row = overlay.cursor.row;
      col = overlay.cursor.col;
    } else {
      if (!core.coreService.isCursorInitialized || core.coreService.isCursorHidden) return null;
      row = buffer.ybase + buffer.y;
      col = buffer.x;
    }
    const y = row - buffer.ydisp;
    if (y < 0 || y >= this.rows) return null;
    const x = Math.min(Math.max(0, col), this.cols - 1);
    const options = core.optionsService.rawOptions;
    let shape: CursorShape;
    if (!core._coreBrowserService.isFocused) {
      const inactive = options.cursorInactiveStyle ?? 'outline';
      shape = inactive === 'none' ? CursorShape.NONE : shapeOf(inactive);
    } else if (this.blinkTimer && !this.blinkVisible) {
      shape = CursorShape.NONE;
    } else {
      shape = shapeOf(options.cursorStyle || 'block');
    }
    if (shape === CursorShape.NONE) return null;
    return { x, y, shape };
  }

  private restartBlink(): void {
    this.stopBlink();
    this.blinkVisible = true;
    if (
      this.disposed ||
      !this.core.optionsService.rawOptions.cursorBlink ||
      !this.core._coreBrowserService.isFocused
    ) {
      this.requestCursorRow();
      return;
    }
    this.blinkTimer = setInterval(() => {
      this.blinkVisible = !this.blinkVisible;
      this.requestCursorRow();
    }, BLINK_INTERVAL_MS);
    this.requestCursorRow();
  }

  private stopBlink(): void {
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.blinkVisible = true;
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
    const ctx = this.decorCtx;
    ctx.clearRect(0, 0, this.decorCanvas.width, this.decorCanvas.height);
    const dims = this.dimensions.device;
    if (!dims.cell.width || !this.rows) return;
    const colors = this.colors();
    const ydisp = this.buffer().ydisp;
    const fill = (x: number, y: number, w: number, h: number) =>
      ctx.fillRect(
        x * dims.cell.width,
        y * dims.cell.height,
        w * dims.cell.width,
        h * dims.cell.height,
      );

    const selection = this.selection;
    if (selection) {
      const startRow = selection.start[1] - ydisp;
      const endRow = selection.end[1] - ydisp;
      const cappedStart = Math.max(startRow, 0);
      const cappedEnd = Math.min(endRow, this.rows - 1);
      if (cappedStart < this.rows && cappedEnd >= 0) {
        ctx.fillStyle = (
          this.core._coreBrowserService.isFocused
            ? colors.selectionBackgroundTransparent
            : colors.selectionInactiveBackgroundTransparent
        ).css;
        if (selection.columnSelectMode) {
          fill(
            selection.start[0],
            cappedStart,
            selection.end[0] - selection.start[0],
            cappedEnd - cappedStart + 1,
          );
        } else {
          const startCol = startRow === cappedStart ? selection.start[0] : 0;
          const firstEnd = cappedStart === endRow ? selection.end[0] : this.cols;
          fill(startCol, cappedStart, firstEnd - startCol, 1);
          fill(0, cappedStart + 1, this.cols, Math.max(cappedEnd - cappedStart - 1, 0));
          if (cappedStart !== cappedEnd) {
            fill(0, cappedEnd, endRow === cappedEnd ? selection.end[0] : this.cols, 1);
          }
        }
      }
    }

    const link = this.link;
    if (link) {
      const dpr = this.core._coreBrowserService.dpr;
      ctx.fillStyle =
        link.fg === 257
          ? colors.background.css
          : link.fg !== undefined && link.fg < 256
            ? (colors.ansi[link.fg]?.css ?? colors.foreground.css)
            : colors.foreground.css;
      const underline = (x: number, y: number, w: number) =>
        ctx.fillRect(
          x * dims.cell.width,
          (y + 1) * dims.cell.height - dpr - 1,
          w * dims.cell.width,
          dpr,
        );
      if (link.y1 === link.y2) {
        underline(link.x1, link.y1, link.x2 - link.x1);
      } else {
        underline(link.x1, link.y1, link.cols - link.x1);
        for (let y = link.y1 + 1; y < link.y2; y++) underline(0, y, link.cols);
        underline(0, link.y2, link.x2);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Geometry

  private dprUsed = 0;

  private updateDimensions(cols: number, rows: number): void {
    const charSize = this.core._charSizeService;
    if (!charSize.hasValidSize) return;
    const dpr = this.core._coreBrowserService.dpr;
    const options = this.core.optionsService.rawOptions;
    const dims = this.dimensions;
    // Same arithmetic as xterm's canvas and WebGL renderers, so cells land on
    // whole device pixels and mouse reports map to the same cells.
    dims.device.char.width = Math.floor(charSize.width * dpr);
    dims.device.char.height = Math.ceil(charSize.height * dpr);
    dims.device.cell.height = Math.floor(dims.device.char.height * options.lineHeight);
    dims.device.char.top =
      options.lineHeight === 1
        ? 0
        : Math.round((dims.device.cell.height - dims.device.char.height) / 2);
    dims.device.cell.width = dims.device.char.width + Math.round(options.letterSpacing);
    dims.device.char.left = Math.floor(options.letterSpacing / 2);
    dims.device.canvas.height = rows * dims.device.cell.height;
    dims.device.canvas.width = cols * dims.device.cell.width;
    dims.css.canvas.height = Math.round(dims.device.canvas.height / dpr);
    dims.css.canvas.width = Math.round(dims.device.canvas.width / dpr);
    dims.css.cell.height = dims.css.canvas.height / rows;
    dims.css.cell.width = dims.css.canvas.width / cols;
    this.dprUsed = dpr;
  }

  private resizeGrid(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const size = cols * rows;
    this.painted = {
      content: new Uint32Array(size).fill(INVALID),
      fg: new Uint32Array(size),
      bg: new Uint32Array(size),
      ext: new Uint32Array(size),
      meta: new Uint32Array(size).fill(INVALID),
      combined: new Array<string>(size).fill(''),
    };
    this.row = {
      content: new Uint32Array(cols),
      fg: new Uint32Array(cols),
      bg: new Uint32Array(cols),
      ext: new Uint32Array(cols),
      combined: new Array<string>(cols).fill(''),
    };
    this.paintedOverlayRows.clear();
    this.paintedCursorRow = -1;
  }

  private configureAtlas(): void {
    const dims = this.dimensions.device;
    const options = this.core.optionsService.rawOptions;
    this.atlas.configure(
      {
        cellWidth: dims.cell.width,
        cellHeight: dims.cell.height,
        charWidth: dims.char.width,
        charHeight: dims.char.height,
        charLeft: dims.char.left,
        charTop: dims.char.top,
        dpr: this.core._coreBrowserService.dpr,
      },
      {
        fontFamily: options.fontFamily,
        fontSize: options.fontSize,
        fontWeight: options.fontWeight,
        fontWeightBold: options.fontWeightBold,
        customGlyphs: options.customGlyphs !== false,
      },
    );
  }

  /** Everything painted is forgotten; the next frame repaints every cell it is asked for. */
  private invalidateAll(): void {
    this.painted.content.fill(INVALID);
    this.painted.meta.fill(INVALID);
    this.paintedCursorRow = -1;
  }

  /**
   * Tracks the canvas's exact size in device pixels. At fractional ratios
   * (125%, 150%) rounding CSS pixels drifts by a pixel and blurs everything;
   * `devicePixelContentBoxSize` is the size the compositor really uses.
   */
  private observeDevicePixels(): void {
    const view = this.core._coreBrowserService.window;
    if (!view || typeof view.ResizeObserver !== 'function') return;
    let observer: ResizeObserver | null = new view.ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === this.canvas);
      if (!entry) return;
      if (!('devicePixelContentBoxSize' in entry) || !entry.devicePixelContentBoxSize?.[0]) {
        observer?.disconnect();
        observer = null;
        return;
      }
      const width = entry.devicePixelContentBoxSize[0].inlineSize;
      const height = entry.devicePixelContentBoxSize[0].blockSize;
      if (width <= 0 || height <= 0) return;
      if (width === this.canvas.width && height === this.canvas.height) return;
      // A rounding correction is a pixel or two. Anything else is a size the
      // cells were not laid out for (emulated device scales report CSS pixels
      // here), and drawing into it would scale the whole grid.
      const dpr = this.core._coreBrowserService.dpr;
      const css = this.dimensions.css.canvas;
      if (Math.abs(width - css.width * dpr) > 2 || Math.abs(height - css.height * dpr) > 2) return;
      this.dimensions.device.canvas.width = width;
      this.dimensions.device.canvas.height = height;
      for (const canvas of [this.canvas, this.decorCanvas]) {
        canvas.width = width;
        canvas.height = height;
      }
      this.invalidateAll();
      this.fillBackground();
      this.redrawDecor();
      this.redraw.fire({ start: 0, end: Math.max(0, this.rows - 1) });
    });
    try {
      observer.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.disconnect();
      observer = null;
    }
    this.disposables.push({ dispose: () => observer?.disconnect() });
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

  private boldBright(): boolean {
    return this.core.optionsService.rawOptions.drawBoldTextInBrightColors !== false;
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

function shapeOf(style: string): CursorShape {
  switch (style) {
    case 'bar':
      return CursorShape.BAR;
    case 'underline':
      return CursorShape.UNDERLINE;
    case 'outline':
      return CursorShape.OUTLINE;
    default:
      return CursorShape.BLOCK;
  }
}

function overlayRows(overlay: PaintOverlay | null): number[] {
  if (!overlay) return [];
  const rows = overlay.cells.map((cell) => cell.row);
  if (overlay.cursor) rows.push(overlay.cursor.row);
  return rows;
}

function addViewportRow(rows: Set<number>, y: number, count: number): void {
  if (y >= 0 && y < count) rows.add(y);
}
