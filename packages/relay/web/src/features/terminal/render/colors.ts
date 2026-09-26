import { Attributes, FgFlags, BgFlags } from './cell';

/** One colour of xterm's theme: `css` to paint with, `rgba` packed as 0xRRGGBBAA. */
interface ThemeColor {
  css: string;
  rgba: number;
}

/**
 * The colours xterm is painting with, from its theme service. With a host
 * palette these are the workstation's own colours; without one, xterm's
 * defaults. The renderer never names a colour of its own.
 */
export interface ThemeColors {
  foreground: ThemeColor;
  background: ThemeColor;
  cursor: ThemeColor;
  cursorAccent: ThemeColor;
  selectionBackgroundTransparent: ThemeColor;
  selectionInactiveBackgroundTransparent: ThemeColor;
  ansi: ReadonlyArray<ThemeColor>;
}

export interface ResolvedColors {
  fg: string;
  bg: string;
  /** Whether the background differs from the terminal's own. */
  bgIsDefault: boolean;
}

const rgbCache = new Map<number, string>();

function rgbCss(rgb: number): string {
  let css = rgbCache.get(rgb);
  if (css === undefined) {
    css = `#${(rgb & Attributes.RGB_MASK).toString(16).padStart(6, '0')}`;
    if (rgbCache.size > 4096) rgbCache.clear();
    rgbCache.set(rgb, css);
  }
  return css;
}

/** A colour word (mode + value) as css, or `fallback` for the default colour. */
export function colorWordCss(word: number, colors: ThemeColors, fallback: string): string {
  switch (word & Attributes.CM_MASK) {
    case Attributes.CM_P16:
    case Attributes.CM_P256:
      return colors.ansi[word & Attributes.PCOLOR_MASK]?.css ?? fallback;
    case Attributes.CM_RGB:
      return rgbCss(word & Attributes.RGB_MASK);
    default:
      return fallback;
  }
}

/**
 * Foreground and background of a cell, resolved the way xterm's own
 * renderers do (`TextureAtlas._drawToCache`): inverse swaps the two colour
 * words first, then bold text whose foreground is one of the first eight
 * palette colours moves to the bright eight (`drawBoldTextInBrightColors`,
 * on by default). A default colour under inverse means the other default.
 */
export function resolveCellColors(
  fgWord: number,
  bgWord: number,
  colors: ThemeColors,
  drawBoldTextInBrightColors: boolean,
): ResolvedColors {
  const inverse = (fgWord & FgFlags.INVERSE) !== 0;
  const fgColor = inverse ? bgWord : fgWord;
  const bgColor = inverse ? fgWord : bgWord;

  let fg: string;
  const fgMode = fgColor & Attributes.CM_MASK;
  if (fgMode === Attributes.CM_P16 || fgMode === Attributes.CM_P256) {
    let index = fgColor & Attributes.PCOLOR_MASK;
    if (drawBoldTextInBrightColors && fgWord & FgFlags.BOLD && index < 8) index += 8;
    fg = colors.ansi[index]?.css ?? colors.foreground.css;
  } else if (fgMode === Attributes.CM_RGB) {
    fg = rgbCss(fgColor & Attributes.RGB_MASK);
  } else {
    fg = inverse ? colors.background.css : colors.foreground.css;
  }

  const bgMode = bgColor & Attributes.CM_MASK;
  const bg =
    bgMode === Attributes.CM_DEFAULT
      ? inverse
        ? colors.foreground.css
        : colors.background.css
      : colorWordCss(bgColor, colors, colors.background.css);
  return { fg, bg, bgIsDefault: !inverse && bgMode === Attributes.CM_DEFAULT };
}

export function isBold(fgWord: number): boolean {
  return (fgWord & FgFlags.BOLD) !== 0;
}

export function isItalic(bgWord: number): boolean {
  return (bgWord & BgFlags.ITALIC) !== 0;
}

export function isDim(bgWord: number): boolean {
  return (bgWord & BgFlags.DIM) !== 0;
}

export function isInvisible(fgWord: number): boolean {
  return (fgWord & FgFlags.INVISIBLE) !== 0;
}
