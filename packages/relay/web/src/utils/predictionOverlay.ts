import type { Terminal, IMarker, IDecoration, IDecorationOptions } from '@xterm/xterm';

export interface PredictionOverlayStyle {
  color?: string;
  background?: string;
  underline: boolean;
}

export interface PredictionOverlayOptions {
  getTerminal: () => Terminal | null;
  getStyle: () => PredictionOverlayStyle;
}

export interface PredictionItem {
  row: number;
  col: number;
  char: string;
}

interface DecorationEntry {
  decoration: IDecoration;
  marker: IMarker;
  char: string;
}

/**
 * xterm IDecorationOptions backgroundColor and foregroundColor strictly accept #RRGGBB.
 * Other values (such as 'inherit', 'currentColor', or named colors) must not be passed to xterm.
 */
function isValidHexColor(color: string | undefined): boolean {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

export class PredictionOverlay {
  private readonly options: PredictionOverlayOptions;
  private readonly activeDecorations = new Map<string, DecorationEntry>();

  constructor(options: PredictionOverlayOptions) {
    this.options = options;
  }

  /**
   * Incrementally updates overlay decorations according to incoming visible predictions.
   * Keeps matching cells untouched to avoid layout thrashing and flickering,
   * while dynamically refreshing visual styles (color, background, underline).
   */
  sync(predictions: ReadonlyArray<PredictionItem>): void {
    const terminal = this.options.getTerminal();
    if (!terminal) {
      this.clear();
      return;
    }

    if (predictions.length === 0) {
      this.clear();
      return;
    }

    // Safety fallback: if xterm proposed decoration APIs are not available, do not crash.
    if (
      typeof terminal.registerMarker !== 'function' ||
      typeof terminal.registerDecoration !== 'function' ||
      !terminal.buffer?.active
    ) {
      this.clear();
      return;
    }

    const nextKeys = new Set<string>();

    for (const pred of predictions) {
      const key = `${pred.row}:${pred.col}`;
      nextKeys.add(key);

      const existing = this.activeDecorations.get(key);
      if (existing) {
        if (existing.char === pred.char) {
          // Character is unchanged; refresh element styles if already mounted to track live theme/srtt changes.
          if (existing.decoration.element) {
            this.applyStyleToElement(existing.decoration.element, existing.char);
          }
          continue;
        }
        // Character changed at this position; recreate decoration.
        this.disposeEntry(existing);
        this.activeDecorations.delete(key);
      }

      try {
        // xterm's registerMarker offset is relative to cursor line:
        // markerLine = (baseY + cursorY) + cursorYOffset
        // To place marker at absolute row `pred.row`, offset is `pred.row - (baseY + cursorY)`.
        const currentCursorLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
        const cursorYOffset = pred.row - currentCursorLine;
        const marker = terminal.registerMarker(cursorYOffset);

        if (!marker || marker.isDisposed || marker.line === -1) {
          continue;
        }

        const currentStyle = this.options.getStyle();
        const decorationOptions: IDecorationOptions = {
          marker,
          anchor: 'left',
          x: pred.col,
          width: 1,
          height: 1,
          layer: 'top',
        };

        if (isValidHexColor(currentStyle.background)) {
          (decorationOptions as { backgroundColor?: string }).backgroundColor = currentStyle.background;
        }
        if (isValidHexColor(currentStyle.color)) {
          (decorationOptions as { foregroundColor?: string }).foregroundColor = currentStyle.color;
        }

        const decoration = terminal.registerDecoration(decorationOptions);

        if (!decoration || decoration.isDisposed) {
          try {
            marker.dispose();
          } catch {
            // ignore
          }
          continue;
        }

        if (decoration.element) {
          this.applyStyleToElement(decoration.element, pred.char);
        }
        decoration.onRender((element) => {
          this.applyStyleToElement(element, pred.char);
        });

        marker.onDispose?.(() => {
          this.activeDecorations.delete(key);
        });

        this.activeDecorations.set(key, { decoration, marker, char: pred.char });
      } catch (err) {
        // Graceful degradation on xterm / DOM failure.
        console.debug('Failed to create prediction decoration:', err);
      }
    }

    // Clean up decorations that are no longer present in visible predictions.
    for (const [key, entry] of this.activeDecorations) {
      if (!nextKeys.has(key)) {
        this.disposeEntry(entry);
        this.activeDecorations.delete(key);
      }
    }
  }

  /**
   * Wipes all active predictive decorations immediately.
   */
  clear(): void {
    for (const entry of this.activeDecorations.values()) {
      this.disposeEntry(entry);
    }
    this.activeDecorations.clear();
  }

  /**
   * Destroys all active decorations and markers on terminal unmount.
   */
  dispose(): void {
    this.clear();
  }

  private applyStyleToElement(element: HTMLElement, char: string): void {
    const style = this.options.getStyle();
    element.textContent = char;
    // Ensure pointer events and selection pass through untouched to the underlying terminal.
    element.style.pointerEvents = 'none';
    element.style.userSelect = 'none';
    if (style.color) {
      element.style.color = style.color;
    }
    if (style.background) {
      element.style.backgroundColor = style.background;
    }
    element.style.textDecoration = style.underline ? 'underline' : 'none';
    element.style.fontFamily = 'inherit';
    element.style.fontSize = 'inherit';
    element.style.overflow = 'hidden';
    element.style.whiteSpace = 'pre';
  }

  private disposeEntry(entry: DecorationEntry): void {
    try {
      entry.decoration.dispose();
    } catch {
      // ignore
    }
    try {
      entry.marker.dispose();
    } catch {
      // ignore
    }
  }
}
