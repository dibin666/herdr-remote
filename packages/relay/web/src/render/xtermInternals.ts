import type { Terminal } from '@xterm/xterm';
import type { RawCell } from './cell';
import type { ThemeColors } from './colors';

/**
 * The parts of xterm 5.5's private core a renderer is built from. These are
 * the same services `@xterm/addon-canvas` and `@xterm/addon-webgl` take, read
 * the same way; the shapes below name only what this renderer uses.
 */

export interface Disposable {
  dispose(): void;
}

export type XtermEvent<T> = (listener: (value: T) => void) => Disposable;

export interface RenderDimensions {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } };
  device: {
    canvas: { width: number; height: number };
    cell: { width: number; height: number };
    char: { width: number; height: number; left: number; top: number };
  };
}

export interface XtermRenderer extends Disposable {
  readonly dimensions: RenderDimensions;
  readonly onRequestRedraw: XtermEvent<{ start: number; end: number }>;
  handleDevicePixelRatioChange(): void;
  handleResize(cols: number, rows: number): void;
  handleCharSizeChanged(): void;
  handleBlur(): void;
  handleFocus(): void;
  handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void;
  handleCursorMove(): void;
  clear(): void;
  renderRows(start: number, end: number): void;
  clearTextureAtlas?(): void;
}

export interface BufferLineInternal {
  readonly length: number;
  loadCell(index: number, cell: RawCell): RawCell;
}

export interface BufferInternal {
  ydisp: number;
  ybase: number;
  x: number;
  y: number;
  lines: { get(index: number): BufferLineInternal | undefined };
}

export interface XtermCore {
  screenElement?: HTMLElement;
  linkifier?: {
    onShowLinkUnderline: XtermEvent<LinkEvent>;
    onHideLinkUnderline: XtermEvent<LinkEvent>;
  };
  coreService: {
    isCursorHidden: boolean;
    isCursorInitialized: boolean;
  };
  optionsService: {
    rawOptions: {
      fontFamily: string;
      fontSize: number;
      fontWeight: string | number;
      fontWeightBold: string | number;
      lineHeight: number;
      letterSpacing: number;
      cursorStyle: 'block' | 'underline' | 'bar';
      cursorInactiveStyle?: 'outline' | 'block' | 'bar' | 'underline' | 'none';
      cursorWidth: number;
      cursorBlink: boolean;
      customGlyphs: boolean;
      drawBoldTextInBrightColors: boolean;
    };
    onOptionChange: XtermEvent<string>;
  };
  _bufferService: {
    cols: number;
    rows: number;
    buffer: BufferInternal;
  };
  _charSizeService: {
    width: number;
    height: number;
    hasValidSize: boolean;
  };
  _coreBrowserService: {
    isFocused: boolean;
    dpr: number;
    window: Window & typeof globalThis;
    mainDocument: Document;
    onWindowChange?: XtermEvent<Window & typeof globalThis>;
  };
  _themeService: {
    colors: ThemeColors;
    onChangeColors: XtermEvent<unknown>;
  };
  _renderService: {
    setRenderer(renderer: XtermRenderer): void;
    handleResize(cols: number, rows: number): void;
    refreshRows(start: number, end: number, isRedrawOnly?: boolean): void;
    dimensions?: RenderDimensions;
  };
  _createRenderer?(): XtermRenderer;
  onWillOpen?: XtermEvent<HTMLElement>;
}

export interface LinkEvent {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cols: number;
  fg: number | undefined;
}

/**
 * The core, or null when any service this renderer needs is missing — a
 * different xterm build, or the test double. The caller then keeps xterm's
 * own renderer.
 */
export function xtermCore(terminal: Terminal): XtermCore | null {
  const core = (terminal as unknown as { _core?: Partial<XtermCore> })._core;
  if (
    !core ||
    !core.screenElement ||
    !core.coreService ||
    !core.optionsService?.rawOptions ||
    !core._bufferService?.buffer ||
    !core._charSizeService ||
    !core._coreBrowserService ||
    !core._themeService?.colors ||
    typeof core._renderService?.setRenderer !== 'function'
  ) {
    return null;
  }
  return core as XtermCore;
}

/** The smallest implementation of xterm's event type. */
export class Emitter<T> {
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
