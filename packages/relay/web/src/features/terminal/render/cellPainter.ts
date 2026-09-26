// The text layer: what each cell of the grid last painted, and repainting
// only the cells whose words (content, colours, attributes) changed. See
// HerdrRenderer for why a frame is diffed cell by cell.

import { BgFlags, Content, cellExt, contentFor, createRawCell, FgFlags } from './cell';
import {
  isBold,
  isDim,
  isInvisible,
  isItalic,
  resolveCellColors,
  type ThemeColors,
} from './colors';
import { CursorShape, type CursorState, paintCursorShape } from './cursor';
import { isDecorated, paintDecorations } from './decorations';
import { DIM_OPACITY, GlyphAtlas, isCustomGlyph } from './glyphAtlas';
import type { OverlayCell } from './paintOverlay';
import type { BufferLineInternal, RenderDimensions, XtermCore } from './xtermInternals';

const INVALID = 0xffffffff;

/** `meta` word of a painted cell: its width in cells, its cursor shape, or covered by the cell before. */
const META_COVERED = 0x4;
const META_CURSOR_SHIFT = 3;

export class CellPainter {
  readonly atlas: GlyphAtlas;
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

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    document: Document,
    private readonly core: XtermCore,
    /** The renderer's dimensions, which it updates in place. */
    private readonly dimensions: RenderDimensions,
  ) {
    this.atlas = new GlyphAtlas(document);
  }

  resize(cols: number, rows: number): void {
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
  }

  /** Everything painted is forgotten; the next frame repaints every cell it is asked for. */
  invalidate(): void {
    this.painted.content.fill(INVALID);
    this.painted.meta.fill(INVALID);
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
        if (word === INVALID || painted.meta[i] === META_COVERED || isInvisible(painted.fg[i]))
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

  /** Reads one viewport row into the scratch arrays, with overlay cells laid over it. */
  loadRow(line: BufferLineInternal | undefined, overlay: OverlayCell[] | undefined): void {
    const { content, fg, bg, ext, combined } = this.row;
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
  paintRow(y: number, cursor: CursorState | null): number {
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
      const meta = cells | (cursorShape << META_CURSOR_SHIFT);

      let dirty = this.differs(base + x, x, meta);
      for (let c = 1; c < cells; c++) {
        if (this.differs(base + x + c, x + c, META_COVERED)) dirty = true;
      }

      if (dirty) {
        for (let c = 0; c < cells; c++) {
          const i = base + x + c;
          painted.content[i] = content[x + c];
          painted.fg[i] = fg[x + c];
          painted.bg[i] = bg[x + c];
          painted.ext[i] = ext[x + c];
          painted.meta[i] = c === 0 ? meta : META_COVERED;
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

    if (!invisible && isDecorated(fgWord, bgWord)) {
      paintDecorations(
        ctx,
        dims,
        { px, py, cells, fgWord, bgWord, ext, fgCss },
        {
          fontSize: this.core.optionsService.rawOptions.fontSize,
          dpr: this.core._coreBrowserService.dpr,
          colors,
          boldBright: this.boldBright(),
        },
      );
    }
    if (cursorShape !== CursorShape.NONE && cursorShape !== CursorShape.BLOCK) {
      paintCursorShape(ctx, dims, px, py, width, cursorShape, {
        css: colors.cursor.css,
        dpr: this.core._coreBrowserService.dpr,
        cursorWidth: this.core.optionsService.rawOptions.cursorWidth,
      });
    }
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

  fillBackground(): void {
    this.ctx.fillStyle = this.colors().background.css;
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
  }

  configureAtlas(): void {
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

  private colors(): ThemeColors {
    return this.core._themeService.colors;
  }

  private boldBright(): boolean {
    return this.core.optionsService.rawOptions.drawBoldTextInBrightColors !== false;
  }
}
