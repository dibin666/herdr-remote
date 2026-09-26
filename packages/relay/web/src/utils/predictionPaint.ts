import type { Terminal } from '@xterm/xterm';
import {
  Attributes,
  BgFlags,
  DEFAULT_STYLE,
  FgFlags,
  readCellStyle,
  type CellStyle,
} from '../render/cell';
import type { OverlayCell, PaintOverlay } from '../render/HerdrRenderer';
import type { OverlayItem } from './predictionModel';

/** What the layer draws into: the canvas renderer, while it is the one in use. */
export interface OverlayTarget {
  setOverlayProvider(provider: (() => PaintOverlay | null) | null): void;
  invalidateOverlay(): void;
}

export interface PredictionLayerOptions {
  getTerminal: () => Terminal | null;
  /** Whether the host has hidden the terminal cursor (DECTCEM). */
  isCursorHidden: () => boolean;
}

/**
 * Hands predicted typing to the renderer as ordinary cells.
 *
 * Nothing here draws. Each prediction becomes a cell with the style the
 * field's echoes have shown, and the renderer paints it with the same glyphs
 * and colours as the rest of the screen. When the echo lands, the buffer holds
 * that same cell and the renderer finds nothing to repaint: no flash, no
 * shift, no change of colour or weight.
 *
 * The caret goes where the next key will land, in the form the program uses:
 * the terminal cursor when the program shows it (a shell, Codex), or a copy of
 * the cell the program paints as its own caret while the terminal cursor is
 * hidden (Claude draws one with a white background). That painted caret, still
 * a round trip behind, is covered with plain text so only one caret shows.
 */
export class PredictionLayer {
  private items: ReadonlyArray<OverlayItem> = [];
  private target: OverlayTarget | null = null;
  private readonly provider = () => this.paint();

  constructor(private readonly options: PredictionLayerOptions) {}

  /** Draws through `target` from now on; null when the terminal fell back to the DOM renderer. */
  attach(target: OverlayTarget | null): void {
    if (this.target === target) return;
    this.target?.setOverlayProvider(null);
    this.target = target;
    target?.setOverlayProvider(this.provider);
  }

  /** Shows exactly `items`. */
  sync(items: ReadonlyArray<OverlayItem>): void {
    if (items.length === 0 && this.items.length === 0) return;
    this.items = items;
    this.target?.invalidateOverlay();
  }

  /** Shows nothing. */
  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.target?.invalidateOverlay();
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  dispose(): void {
    this.attach(null);
    this.items = [];
  }

  /** The overlay as the renderer reads it, built against the buffer as it is now. */
  paint(): PaintOverlay | null {
    if (this.items.length === 0) return null;
    const terminal = this.options.getTerminal();
    const active = terminal?.buffer.active;
    if (!terminal || !active) return null;

    const cells: OverlayCell[] = [];
    const cursorHidden = this.options.isCursorHidden();
    const serverRow = active.baseY + active.cursorY;
    const serverCol = active.cursorX;
    const serverStyle = styleAt(terminal, serverRow, serverCol);
    const paintsOwnCaret = cursorHidden && !!serverStyle && looksLikeCaret(serverStyle);
    let cursor: PaintOverlay['cursor'];

    for (const item of this.items) {
      switch (item.kind) {
        case 'char':
          cells.push({
            row: item.row,
            col: item.col,
            chars: item.char,
            width: item.width,
            style: item.style ?? textStyleNear(terminal, item.row, item.col),
          });
          break;
        case 'erase':
          cells.push({
            row: item.row,
            col: item.col,
            chars: ' ',
            width: item.width,
            style: blankStyle(item.style ?? styleAt(terminal, item.row, item.col) ?? DEFAULT_STYLE),
          });
          break;
        case 'mask':
          // Only a caret the program painted itself needs covering.
          if (paintsOwnCaret && item.row === serverRow && item.col === serverCol) {
            cells.push({
              row: item.row,
              col: item.col,
              chars: item.char,
              width: 1,
              style: item.style ?? plainStyle(serverStyle!),
            });
          }
          break;
        case 'caret':
          if (!cursorHidden) {
            cursor = { row: item.row, col: item.col };
          } else if (paintsOwnCaret) {
            cells.push({
              row: item.row,
              col: item.col,
              chars: item.char,
              width: 1,
              style: serverStyle!,
            });
          }
          break;
      }
    }
    return cursor === undefined ? { cells } : { cells, cursor };
  }
}

function styleAt(terminal: Terminal, row: number, col: number): CellStyle | null {
  if (col < 0 || col >= terminal.cols) return null;
  return readCellStyle(terminal.buffer.active.getLine(row)?.getCell(col));
}

/**
 * A caret a program paints itself is a cell set apart from the text around
 * it: reversed, or on a background of its own.
 */
function looksLikeCaret(style: CellStyle): boolean {
  return (
    (style.fg & FgFlags.INVERSE) !== 0 || (style.bg & Attributes.CM_MASK) !== Attributes.CM_DEFAULT
  );
}

/** A painted caret's cell as it looks without the caret: plain text. */
function plainStyle(style: CellStyle): CellStyle {
  return {
    fg: style.fg & ~FgFlags.INVERSE,
    bg: style.bg & ~(Attributes.CM_MASK | Attributes.RGB_MASK),
    ext: style.ext,
  };
}

/** A cleared cell keeps its background and nothing else. */
function blankStyle(style: CellStyle): CellStyle {
  const inverse = style.fg & FgFlags.INVERSE;
  return {
    fg: inverse ? style.fg & (FgFlags.INVERSE | Attributes.CM_MASK | Attributes.RGB_MASK) : 0,
    bg: style.bg & (Attributes.CM_MASK | Attributes.RGB_MASK),
    ext: 0,
  };
}

/**
 * Before a field has echoed anything its text style is unknown; the text to
 * the left is the best guess, when it is ordinary text rather than a caret.
 */
function textStyleNear(terminal: Terminal, row: number, col: number): CellStyle {
  const left = styleAt(terminal, row, col - 1);
  if (left && !looksLikeCaret(left) && !(left.bg & BgFlags.DIM)) return left;
  return DEFAULT_STYLE;
}
