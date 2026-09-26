/**
 * How xterm 5.5 packs a cell, read straight from its buffer.
 *
 * A cell is three 32-bit words (content, fg, bg) plus, when the bg word says
 * so, an extended-attributes object and, for combined characters, a string.
 * The renderer compares these words to decide what changed, which is far
 * cheaper than asking the public cell API for each attribute. The values
 * mirror xterm's `common/buffer/Constants.ts`.
 */

export enum Content {
  CODEPOINT_MASK = 0x1fffff,
  IS_COMBINED_MASK = 0x200000,
  WIDTH_SHIFT = 22,
}

export enum Attributes {
  PCOLOR_MASK = 0xff,
  CM_MASK = 0x3000000,
  CM_DEFAULT = 0,
  CM_P16 = 0x1000000,
  CM_P256 = 0x2000000,
  CM_RGB = 0x3000000,
  RGB_MASK = 0xffffff,
}

export enum FgFlags {
  INVERSE = 0x4000000,
  BOLD = 0x8000000,
  UNDERLINE = 0x10000000,
  BLINK = 0x20000000,
  INVISIBLE = 0x40000000,
  STRIKETHROUGH = 0x80000000,
}

export enum BgFlags {
  ITALIC = 0x4000000,
  DIM = 0x8000000,
  HAS_EXTENDED = 0x10000000,
  PROTECTED = 0x20000000,
  OVERLINE = 0x40000000,
}

export enum UnderlineStyle {
  NONE = 0,
  SINGLE = 1,
  DOUBLE = 2,
  CURLY = 3,
  DOTTED = 4,
  DASHED = 5,
}

/** What xterm's `BufferLine.loadCell` writes into. */
export interface RawCell {
  content: number;
  fg: number;
  bg: number;
  combinedData: string;
  extended:
    | { ext: number; underlineStyle: number; underlineColor: number; urlId?: number }
    | undefined;
}

export function createRawCell(): RawCell {
  return { content: 0, fg: 0, bg: 0, combinedData: '', extended: undefined };
}

/** The attributes of a cell, as the three words xterm stores them in. */
export interface CellStyle {
  fg: number;
  bg: number;
  /** Extended attributes (underline style and colour); 0 when there are none. */
  ext: number;
}

export const DEFAULT_STYLE: Readonly<CellStyle> = { fg: 0, bg: 0, ext: 0 };

export function cellWidth(content: number): number {
  return content >>> Content.WIDTH_SHIFT;
}

export function cellChars(cell: Pick<RawCell, 'content' | 'combinedData'>): string {
  if (cell.content & Content.IS_COMBINED_MASK) return cell.combinedData;
  const code = cell.content & Content.CODEPOINT_MASK;
  return code ? String.fromCodePoint(code) : '';
}

/** Extended attributes in effect, 0 unless the bg word flags them. */
export function cellExt(cell: Pick<RawCell, 'bg' | 'extended'>): number {
  return cell.bg & BgFlags.HAS_EXTENDED && cell.extended ? cell.extended.ext >>> 0 : 0;
}

export function underlineStyleOf(ext: number): UnderlineStyle {
  return ((ext >>> 26) & 0x7) as UnderlineStyle;
}

export function underlineColorOf(ext: number): number {
  return ext & (Attributes.CM_MASK | Attributes.RGB_MASK);
}

/**
 * The content word for a single character of the given width, as xterm would
 * store it. Characters outside the BMP are stored by code point too.
 */
export function contentFor(chars: string, width: 1 | 2): { content: number; combinedData: string } {
  const code = chars.codePointAt(0) ?? 0;
  const isSingle = chars.length > 0 && String.fromCodePoint(code).length === chars.length;
  if (isSingle) return { content: code | (width << Content.WIDTH_SHIFT), combinedData: '' };
  return {
    content: Content.IS_COMBINED_MASK | (width << Content.WIDTH_SHIFT),
    combinedData: chars,
  };
}

/** Reads the raw words of a public-API cell, which in xterm 5.5 is the internal cell object. */
export function readCellStyle(cell: unknown): CellStyle | null {
  const raw = cell as Partial<RawCell> | null | undefined;
  if (!raw || typeof raw.fg !== 'number' || typeof raw.bg !== 'number') return null;
  return { fg: raw.fg >>> 0, bg: raw.bg >>> 0, ext: cellExt(raw as RawCell) };
}
