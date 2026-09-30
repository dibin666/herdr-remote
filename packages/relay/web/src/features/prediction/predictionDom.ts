import type { Terminal } from '@xterm/xterm';
import { DEFAULT_STYLE, FgFlags, readCellStyle } from '@/features/terminal/render/cell';
import {
  isBold,
  isDim,
  isInvisible,
  isItalic,
  resolveCellColors,
} from '@/features/terminal/render/colors';
import type { OverlayCell, PaintOverlay } from '@/features/terminal/render/paintOverlay';
import {
  type Disposable,
  type XtermCore,
  xtermCore,
} from '@/features/terminal/render/xtermInternals';
import type { OverlayTarget } from './predictionPaint';

/** Draws the same cell overlay when xterm's DOM renderer is in use. */
export class DomPredictionTarget implements OverlayTarget {
  private provider: (() => PaintOverlay | null) | null = null;
  private readonly core: XtermCore | null;
  private readonly layer: HTMLDivElement | null;
  private readonly subscriptions: Disposable[] = [];

  constructor(private readonly terminal: Terminal) {
    this.core = xtermCore(terminal);
    const screen = this.core?.screenElement;
    this.layer = screen ? screen.ownerDocument.createElement('div') : null;
    if (screen && this.layer) {
      this.layer.setAttribute('aria-hidden', 'true');
      Object.assign(this.layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '7',
        overflow: 'hidden',
      });
      screen.append(this.layer);
      this.subscriptions.push(
        terminal.onRender(() => this.invalidateOverlay()),
        terminal.onScroll(() => this.invalidateOverlay()),
      );
    }
  }

  setOverlayProvider(provider: (() => PaintOverlay | null) | null): void {
    this.provider = provider;
    this.invalidateOverlay();
  }

  invalidateOverlay(): void {
    const core = this.core;
    const layer = this.layer;
    const screen = core?.screenElement;
    if (!core || !layer || !screen) return;
    layer.replaceChildren();
    delete screen.dataset.predictiveEcho;
    const overlay = this.provider?.();
    const size = core._renderService.dimensions?.css.cell;
    if (!overlay?.cells.length || !size?.width || !size.height) return;
    const options = core.optionsService.rawOptions;
    const colors = core._themeService.colors;
    const active = this.terminal.buffer.active;
    const draw = (cell: OverlayCell) => {
      const y = cell.row - active.viewportY;
      if (y < 0 || y >= this.terminal.rows) return null;
      const node = screen.ownerDocument.createElement('span');
      const color = resolveCellColors(
        cell.style.fg,
        cell.style.bg,
        colors,
        options.drawBoldTextInBrightColors,
      );
      node.textContent = isInvisible(cell.style.fg) ? ' ' : cell.chars;
      Object.assign(node.style, {
        position: 'absolute',
        left: `${cell.col * size.width}px`,
        top: `${y * size.height}px`,
        width: `${cell.width * size.width}px`,
        height: `${size.height}px`,
        lineHeight: `${size.height}px`,
        whiteSpace: 'pre',
        color: isDim(cell.style.bg) ? `color-mix(in srgb, ${color.fg} 50%, ${color.bg})` : color.fg,
        backgroundColor: color.bg,
        fontFamily: options.fontFamily,
        fontSize: `${options.fontSize}px`,
        fontWeight: String(isBold(cell.style.fg) ? options.fontWeightBold : options.fontWeight),
        fontStyle: isItalic(cell.style.bg) ? 'italic' : 'normal',
        textDecoration: cell.style.fg & FgFlags.UNDERLINE ? 'underline' : 'none',
      });
      layer.append(node);
      return node;
    };
    if (overlay.cursor) {
      // Hiding xterm's old cursor also hides its text; repaint that cell beneath the guesses.
      screen.dataset.predictiveEcho = 'true';
      const rule = screen.ownerDocument.createElement('style');
      rule.textContent =
        '.xterm-screen[data-predictive-echo] .xterm-cursor { visibility: hidden; }';
      layer.append(rule);
      const row = active.baseY + active.cursorY;
      const cell = active.getLine(row)?.getCell(active.cursorX);
      draw({
        row,
        col: active.cursorX,
        chars: cell?.getChars() || ' ',
        width: cell?.getWidth() === 2 ? 2 : 1,
        style: readCellStyle(cell) ?? DEFAULT_STYLE,
      });
    }
    for (const cell of overlay.cells) draw(cell);
    if (overlay.cursor) {
      const { row, col } = overlay.cursor;
      const cell = active.getLine(row)?.getCell(col);
      const pending = [...overlay.cells]
        .reverse()
        .find((candidate) => candidate.row === row && candidate.col === col);
      const caret = draw(
        pending ?? {
          row,
          col,
          chars: cell?.getChars() || ' ',
          width: 1,
          style: readCellStyle(cell) ?? DEFAULT_STYLE,
        },
      );
      if (caret) {
        const style = options.cursorStyle;
        if (!core._coreBrowserService.isFocused || style !== 'block') {
          caret.style.backgroundColor = 'transparent';
          caret.textContent = '';
          caret.style.boxSizing = 'border-box';
          const edge =
            style === 'bar' ? 'borderLeft' : style === 'underline' ? 'borderBottom' : 'border';
          caret.style[edge] =
            `${style === 'bar' ? options.cursorWidth || 1 : 1}px solid ${colors.cursor.css}`;
        } else {
          caret.style.color = colors.cursorAccent.css;
          caret.style.backgroundColor = colors.cursor.css;
        }
      }
    }
  }

  dispose(): void {
    this.provider = null;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.layer?.remove();
    if (this.core?.screenElement) delete this.core.screenElement.dataset.predictiveEcho;
  }
}
