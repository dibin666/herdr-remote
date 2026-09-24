import { tryDrawCustomChar } from './customGlyphs';

/**
 * Glyphs rasterised once and copied into place with `drawImage`.
 *
 * A slot is a whole cell (or two, for wide characters): the cell's
 * background with the glyph drawn over it. Rasterising onto the real
 * background lets the browser antialias text the way it does anywhere else
 * on the page (LCD where the platform uses it), and a slot that is already
 * opaque paints its cell in one copy.
 *
 * Pages are plain opaque canvases filled shelf by shelf. When the last page
 * is full, everything is dropped and the atlas starts over: it is a cache,
 * and what was already painted stays painted.
 */

export interface GlyphMetrics {
  /** Device pixels. */
  cellWidth: number;
  cellHeight: number;
  charWidth: number;
  charHeight: number;
  charLeft: number;
  charTop: number;
  dpr: number;
}

export interface GlyphFont {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontWeightBold: string | number;
  customGlyphs: boolean;
}

export interface GlyphRequest {
  chars: string;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  fg: string;
  bg: string;
  /** Cells the slot spans. */
  cells: number;
}

export interface GlyphSlot {
  source: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DIM_OPACITY = 0.5;
const PAGE_SIZE = 1024;
const MAX_PAGES = 6;

/**
 * Chrome and Safari align glyphs best on the ideographic baseline; Firefox
 * truncates with it (xterm issue 3353). Same choice as xterm's renderers.
 */
export function textBaseline(userAgent: string): CanvasTextBaseline {
  return /Firefox\//.test(userAgent) || /Edge\/\d/.test(userAgent) ? 'bottom' : 'ideographic';
}

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  shelfY: number;
  shelfX: number;
}

export class GlyphAtlas {
  private pages: Page[] = [];
  private readonly slots = new Map<string, GlyphSlot>();
  private readonly inkCache = new Map<string, number>();
  private metrics: GlyphMetrics | null = null;
  private font: GlyphFont | null = null;
  private readonly baseline: CanvasTextBaseline;
  /** Bumped whenever cached slots are thrown away. */
  generation = 0;

  constructor(
    private readonly document: Document,
    userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  ) {
    this.baseline = textBaseline(userAgent);
  }

  /** New cell metrics or font: every slot is stale. */
  configure(metrics: GlyphMetrics, font: GlyphFont): void {
    const same =
      this.metrics &&
      this.font &&
      this.metrics.cellWidth === metrics.cellWidth &&
      this.metrics.cellHeight === metrics.cellHeight &&
      this.metrics.charWidth === metrics.charWidth &&
      this.metrics.charHeight === metrics.charHeight &&
      this.metrics.charLeft === metrics.charLeft &&
      this.metrics.charTop === metrics.charTop &&
      this.metrics.dpr === metrics.dpr &&
      this.font.fontFamily === font.fontFamily &&
      this.font.fontSize === font.fontSize &&
      this.font.fontWeight === font.fontWeight &&
      this.font.fontWeightBold === font.fontWeightBold &&
      this.font.customGlyphs === font.customGlyphs;
    this.metrics = { ...metrics };
    this.font = { ...font };
    if (!same) this.clear();
  }

  clear(): void {
    this.slots.clear();
    this.inkCache.clear();
    for (const page of this.pages) {
      page.shelfX = 0;
      page.shelfY = 0;
    }
    this.generation++;
  }

  dispose(): void {
    this.slots.clear();
    this.inkCache.clear();
    for (const page of this.pages) {
      page.canvas.width = 0;
      page.canvas.height = 0;
    }
    this.pages = [];
  }

  get pageCount(): number {
    return this.pages.length;
  }

  fontString(bold: boolean, italic: boolean): string {
    const font = this.font!;
    const weight = bold ? font.fontWeightBold : font.fontWeight;
    return `${italic ? 'italic ' : ''}${weight} ${font.fontSize * this.metrics!.dpr}px ${font.fontFamily}`;
  }

  /**
   * How many device pixels of ink the glyph puts beyond the right edge of a
   * one-cell slot. Positive for symbols a fallback font draws wider than the
   * cell, such as Claude's `⏺`.
   */
  overflow(chars: string, bold: boolean, italic: boolean): number {
    if (!this.metrics || !this.font) return 0;
    if (chars.length === 1 && chars.charCodeAt(0) < 0x80) return 0;
    const key = `${bold ? 1 : 0}${italic ? 1 : 0}${chars}`;
    const cached = this.inkCache.get(key);
    if (cached !== undefined) return cached;
    let value = 0;
    const ctx = this.scratchContext();
    if (ctx && !(this.font.customGlyphs && isCustomGlyph(chars))) {
      ctx.font = this.fontString(bold, italic);
      ctx.textBaseline = this.baseline;
      const measured = ctx.measureText(chars);
      const right =
        typeof measured.actualBoundingBoxRight === 'number' ? measured.actualBoundingBoxRight : measured.width;
      value = Math.max(0, Math.ceil(this.metrics.charLeft + right - this.metrics.cellWidth));
    }
    this.inkCache.set(key, value);
    return value;
  }

  get(request: GlyphRequest): GlyphSlot | null {
    const metrics = this.metrics;
    const font = this.font;
    if (!metrics || !font || metrics.cellWidth <= 0 || metrics.cellHeight <= 0) return null;
    const key = `${request.cells}${request.bold ? 1 : 0}${request.italic ? 1 : 0}${request.dim ? 1 : 0}${request.fg}\u0000${request.bg}\u0000${request.chars}`;
    const cached = this.slots.get(key);
    if (cached) return cached;

    const width = metrics.cellWidth * request.cells;
    const height = metrics.cellHeight;
    const place = this.allocate(width, height);
    if (!place) return null;
    const { page, x, y } = place;
    const ctx = page.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.globalAlpha = 1;
    ctx.fillStyle = request.bg;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = request.fg;
    if (request.dim) ctx.globalAlpha = DIM_OPACITY;
    let drawn = false;
    if (font.customGlyphs) {
      drawn = tryDrawCustomChar(ctx, request.chars, x, y, metrics.cellWidth, metrics.cellHeight, font.fontSize, metrics.dpr);
    }
    if (!drawn) {
      ctx.font = this.fontString(request.bold, request.italic);
      ctx.textBaseline = this.baseline;
      ctx.fillText(request.chars, x + metrics.charLeft, y + metrics.charTop + metrics.charHeight);
    }
    ctx.restore();

    const slot: GlyphSlot = { source: page.canvas, x, y, width, height };
    this.slots.set(key, slot);
    return slot;
  }

  private allocate(width: number, height: number): { page: Page; x: number; y: number } | null {
    for (const page of this.pages) {
      const spot = this.fit(page, width, height);
      if (spot) return spot;
    }
    if (this.pages.length < MAX_PAGES) {
      const page = this.createPage(Math.max(PAGE_SIZE, width, height));
      if (!page) return null;
      this.pages.push(page);
      return this.fit(page, width, height);
    }
    // Every page is full: start over.
    this.clear();
    return this.pages[0] ? this.fit(this.pages[0], width, height) : null;
  }

  private fit(page: Page, width: number, height: number): { page: Page; x: number; y: number } | null {
    if (page.shelfX + width > page.canvas.width) {
      page.shelfX = 0;
      page.shelfY += height;
    }
    if (page.shelfY + height > page.canvas.height || width > page.canvas.width) return null;
    const spot = { page, x: page.shelfX, y: page.shelfY };
    page.shelfX += width;
    return spot;
  }

  private createPage(size: number): Page | null {
    const canvas = this.document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    return { canvas, ctx, shelfX: 0, shelfY: 0 };
  }

  private scratch: CanvasRenderingContext2D | null | undefined;

  private scratchContext(): CanvasRenderingContext2D | null {
    if (this.scratch === undefined) {
      const canvas = this.document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      this.scratch = canvas.getContext('2d');
    }
    return this.scratch;
  }
}

/** Box drawing, block elements and Powerline: drawn by `tryDrawCustomChar`, always within the cell. */
export function isCustomGlyph(chars: string): boolean {
  if (chars.length !== 1) return false;
  const code = chars.charCodeAt(0);
  return (code >= 0x2500 && code <= 0x259f) || (code >= 0xe0a0 && code <= 0xe0d6);
}
