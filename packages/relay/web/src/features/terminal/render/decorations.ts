// Underlines (single, double, curly, dotted, dashed, coloured), overlines
// and strikethrough, drawn over a painted cell.

import { BgFlags, FgFlags, UnderlineStyle, underlineColorOf, underlineStyleOf } from './cell';
import { colorWordCss, isBold, isDim, type ThemeColors } from './colors';
import { DIM_OPACITY } from './glyphAtlas';
import type { RenderDimensions } from './xtermInternals';

/** One cell run, in device pixels, with the words that say how it is decorated. */
export interface DecoratedCell {
  px: number;
  py: number;
  cells: number;
  fgWord: number;
  bgWord: number;
  ext: number;
  fgCss: string;
}

export interface DecorationEnv {
  fontSize: number;
  dpr: number;
  colors: ThemeColors;
  boldBright: boolean;
}

/** Whether a cell with these words has any line to draw. */
export function isDecorated(fgWord: number, bgWord: number): boolean {
  return (
    (fgWord & (FgFlags.UNDERLINE | FgFlags.STRIKETHROUGH)) !== 0 ||
    (bgWord & BgFlags.OVERLINE) !== 0
  );
}

/** Draws a decorated cell's lines; check `isDecorated` first, as painting is hot. */
export function paintDecorations(
  ctx: CanvasRenderingContext2D,
  dims: RenderDimensions['device'],
  { px, py, cells, fgWord, bgWord, ext, fgCss }: DecoratedCell,
  { fontSize, dpr, colors, boldBright }: DecorationEnv,
): void {
  const underline = (fgWord & FgFlags.UNDERLINE) !== 0;
  const strike = (fgWord & FgFlags.STRIKETHROUGH) !== 0;
  const overline = (bgWord & BgFlags.OVERLINE) !== 0;
  const width = cells * dims.cell.width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, width, dims.cell.height);
  ctx.clip();
  if (isDim(bgWord)) ctx.globalAlpha = DIM_OPACITY;

  const lineWidth = Math.max(1, Math.floor((fontSize * dpr) / 15));
  const half = lineWidth % 2 === 1 ? 0.5 : 0;
  if (underline) {
    const colorWord = underlineColorOf(ext);
    let stroke = fgCss;
    if (colorWord) {
      let word = colorWord;
      if (boldBright && isBold(fgWord) && (word & 0x3000000) !== 0x3000000 && (word & 0xff) < 8)
        word += 8;
      stroke = colorWordCss(word, colors, fgCss);
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
    const strikeWidth = Math.max(1, Math.floor((fontSize * dpr) / 10));
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
