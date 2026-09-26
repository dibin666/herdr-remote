// Characters typed into an input field fade in, and deleted ones fade out,
// instead of popping in and out. On a slow link the echo lands a few keys at
// a time; staggered across the burst, the fade reads as typing, not jumps.

import { Content, UNPAINTED } from './cell';
import { isBold, isDim, isInvisible, isItalic } from './colors';
import type { GlyphAtlas } from './glyphAtlas';

/** How long one cell takes to fade in or out. */
const FADE_MS = 120;
/** Between the starts of characters that landed in the same frame, left to right. */
const STAGGER_MS = 16;
const MAX_STAGGER_MS = 96;
/** More cells than this appearing or clearing at once is a redraw, not typing. */
const MAX_TYPED_CELLS = 32;
/** Set in a painted cell's `meta` while it fades, so the next frame paints it again. */
export const META_FADING = 0x40;

/** Cell words the painter keeps: what it painted, or the row it is about to paint. */
export interface CellWords {
  content: Uint32Array;
  fg: Uint32Array;
  bg: Uint32Array;
  combined: string[];
}

/** A character's words, as they were when it started fading. */
interface FadedGlyph {
  content: number;
  fg: number;
  bg: number;
  combined: string;
}

export interface FadingCell {
  /** How much of the character is drawn, from 0 to 1. */
  alpha: number;
  /** A character deleted from the cell, drawn over the blank that replaced it; absent when fading in. */
  gone?: FadedGlyph;
}

interface Fade extends FadedGlyph {
  start: number;
  out: boolean;
}

function isGlyph(words: CellWords, i: number): boolean {
  const word = words.content[i];
  // The right half of a wide character is drawn with its left.
  if (word >>> Content.WIDTH_SHIFT === 0 || isInvisible(words.fg[i])) return false;
  if (word & Content.IS_COMBINED_MASK) return words.combined[i] !== '';
  const code = word & Content.CODEPOINT_MASK;
  return code !== 0 && code !== 32;
}

function glyphAt(words: CellWords, i: number): FadedGlyph {
  return {
    content: words.content[i],
    fg: words.fg[i],
    bg: words.bg[i],
    combined: words.combined[i],
  };
}

/** The cells fading on the painter's grid, keyed by their index in it. */
export class CellFades {
  private readonly fades = new Map<number, Fade>();

  get size(): number {
    return this.fades.size;
  }

  clear(): void {
    this.fades.clear();
  }

  /** Viewport rows with a fade still running. */
  rows(cols: number): Set<number> {
    const rows = new Set<number>();
    for (const i of this.fades.keys()) rows.add(Math.floor(i / cols));
    return rows;
  }

  /**
   * Starts fading the cells of viewport row `y`, between `start` and `end`,
   * that a character has just filled or left blank, provided nothing else
   * there changed: a character replaced by another is a redraw (a box
   * reflowing, a placeholder giving way), and a redraw is shown at once.
   */
  begin(
    y: number,
    cols: number,
    zone: { start: number; end: number },
    painted: CellWords,
    row: CellWords,
    now: number,
  ): void {
    const base = y * cols;
    const start = Math.max(0, zone.start);
    const end = Math.min(cols, zone.end);
    let changed = 0;
    for (let x = start; x < end; x++) {
      const i = base + x;
      if (painted.content[i] === UNPAINTED) return;
      const was = isGlyph(painted, i);
      const is = isGlyph(row, x);
      if (was && is) {
        if (painted.content[i] !== row.content[x] || painted.combined[i] !== row.combined[x])
          return;
      } else if (was || is) {
        changed++;
      }
    }
    if (changed === 0 || changed > MAX_TYPED_CELLS) return;

    let typed = 0;
    for (let x = start; x < end; x++) {
      const i = base + x;
      const was = isGlyph(painted, i);
      const is = isGlyph(row, x);
      if (is && !was) {
        const delay = Math.min(typed++ * STAGGER_MS, MAX_STAGGER_MS);
        this.fades.set(i, { ...glyphAt(row, x), start: now + delay, out: false });
      } else if (was && !is) {
        this.fades.set(i, { ...glyphAt(painted, i), start: now, out: true });
      }
    }
  }

  /**
   * How cell `i`, column `x` of the row being painted, is drawn while it
   * fades; null when it is not fading. A cell that changed again since it
   * started stops fading and is drawn as it now is.
   */
  at(i: number, x: number, row: CellWords, now: number): FadingCell | null {
    const fade = this.fades.get(i);
    if (!fade) return null;
    const holds = fade.out
      ? !isGlyph(row, x)
      : row.content[x] === fade.content && row.combined[x] === fade.combined;
    const t = (now - fade.start) / FADE_MS;
    if (!holds || t >= 1) {
      this.fades.delete(i);
      return null;
    }
    const p = Math.max(0, t);
    // Easing out: a typed character is legible almost at once, and settles.
    if (!fade.out) return { alpha: 1 - (1 - p) ** 3 };
    return { alpha: (1 - p) ** 2, gone: fade };
  }
}

/** A deleted character, fading out over the blank cell that replaced it. */
export function paintGone(
  ctx: CanvasRenderingContext2D,
  atlas: GlyphAtlas,
  { gone, alpha }: FadingCell,
  colors: { fg: string; bg: string },
  at: { px: number; py: number; width: number; height: number; cells: number },
): void {
  if (!gone) return;
  const chars =
    gone.content & Content.IS_COMBINED_MASK
      ? gone.combined
      : String.fromCodePoint(gone.content & Content.CODEPOINT_MASK);
  const slot = atlas.get({
    chars,
    bold: isBold(gone.fg),
    italic: isItalic(gone.bg),
    dim: isDim(gone.bg),
    fg: colors.fg,
    bg: colors.bg,
    cells: at.cells,
  });
  if (!slot) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(
    slot.source,
    slot.x,
    slot.y,
    slot.width,
    slot.height,
    at.px,
    at.py,
    at.width,
    at.height,
  );
  ctx.globalAlpha = 1;
}
