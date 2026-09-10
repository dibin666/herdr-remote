import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PredictionOverlay } from '../utils/predictionOverlay';
import type { Terminal, IMarker, IDecoration, IDecorationOptions } from '@xterm/xterm';

interface MockMarker extends IMarker {
  disposeMock: ReturnType<typeof vi.fn>;
  fireDispose: () => void;
}

interface MockDecoration extends IDecoration {
  disposeMock: ReturnType<typeof vi.fn>;
  renderCallbacks: Array<(el: HTMLElement) => void>;
  triggerRender: (el: HTMLElement) => void;
}

const createMockMarker = (id: number, line = 0): MockMarker => {
  let isDisposed = false;
  const disposeCallbacks: Array<() => void> = [];
  const disposeMock = vi.fn(() => {
    isDisposed = true;
    for (const cb of disposeCallbacks) cb();
  });

  return {
    id,
    line,
    get isDisposed() {
      return isDisposed;
    },
    onDispose: vi.fn((cb: () => void) => {
      disposeCallbacks.push(cb);
      return {
        dispose: () => {
          const idx = disposeCallbacks.indexOf(cb);
          if (idx !== -1) disposeCallbacks.splice(idx, 1);
        },
      };
    }),
    dispose: disposeMock,
    disposeMock,
    fireDispose: () => {
      isDisposed = true;
      for (const cb of disposeCallbacks) cb();
    },
  };
};

const createMockDecoration = (marker: IMarker): MockDecoration => {
  let isDisposed = false;
  const renderCallbacks: Array<(el: HTMLElement) => void> = [];
  const disposeMock = vi.fn(() => {
    isDisposed = true;
  });

  const decoration: MockDecoration = {
    marker,
    element: undefined,
    options: {},
    get isDisposed() {
      return isDisposed;
    },
    onRender: vi.fn((cb: (el: HTMLElement) => void) => {
      renderCallbacks.push(cb);
      return {
        dispose: () => {
          const idx = renderCallbacks.indexOf(cb);
          if (idx !== -1) renderCallbacks.splice(idx, 1);
        },
      };
    }),
    onDispose: vi.fn(),
    dispose: disposeMock,
    disposeMock,
    renderCallbacks,
    triggerRender: (el: HTMLElement) => {
      decoration.element = el;
      for (const cb of renderCallbacks) cb(el);
    },
  };
  return decoration;
};

describe('PredictionOverlay', () => {
  let markerIdCounter: number;
  let createdMarkers: MockMarker[];
  let createdDecorations: MockDecoration[];
  let registerMarkerMock: ReturnType<typeof vi.fn>;
  let registerDecorationMock: ReturnType<typeof vi.fn>;
  let mockTerminal: unknown;

  beforeEach(() => {
    markerIdCounter = 0;
    createdMarkers = [];
    createdDecorations = [];

    registerMarkerMock = vi.fn((cursorYOffset?: number) => {
      const marker = createMockMarker(++markerIdCounter, (cursorYOffset ?? 0));
      createdMarkers.push(marker);
      return marker;
    });

    registerDecorationMock = vi.fn((options: IDecorationOptions) => {
      const decoration = createMockDecoration(options.marker);
      createdDecorations.push(decoration);
      return decoration;
    });

    mockTerminal = {
      buffer: {
        active: {
          baseY: 10,
          cursorY: 2,
        },
      },
      registerMarker: registerMarkerMock,
      registerDecoration: registerDecorationMock,
    };
  });

  const createOverlay = (
    styleOverride?:
      | { color?: string; background?: string; underline?: boolean }
      | (() => { color?: string; background?: string; underline?: boolean })
  ) => {
    return new PredictionOverlay({
      getTerminal: () => mockTerminal as unknown as Terminal,
      getStyle: () => {
        if (typeof styleOverride === 'function') {
          const s = styleOverride();
          return {
            color: s.color ?? '#ffcc00',
            background: s.background,
            underline: s.underline ?? false,
          };
        }
        return {
          color: styleOverride?.color ?? '#ffcc00',
          background: styleOverride?.background,
          underline: styleOverride?.underline ?? false,
        };
      },
    });
  };

  it('sync() creates a decoration for each visible prediction on first call', () => {
    const overlay = createOverlay();

    overlay.sync([
      { row: 12, col: 5, char: 'h' },
      { row: 12, col: 6, char: 'i' },
    ]);

    expect(registerMarkerMock).toHaveBeenCalledTimes(2);
    expect(registerDecorationMock).toHaveBeenCalledTimes(2);

    // Current cursor line is baseY (10) + cursorY (2) = 12.
    // Prediction row is 12, so offset from cursor should be 12 - 12 = 0.
    expect(registerMarkerMock).toHaveBeenNthCalledWith(1, 0);
    expect(registerMarkerMock).toHaveBeenNthCalledWith(2, 0);

    expect(registerDecorationMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      x: 5,
      width: 1,
      height: 1,
      layer: 'top',
    }));
    expect(registerDecorationMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      x: 6,
      width: 1,
      height: 1,
      layer: 'top',
    }));
  });

  it('sync() does not recreate decorations when called with identical predictions', () => {
    const overlay = createOverlay();

    overlay.sync([
      { row: 12, col: 5, char: 'a' },
      { row: 12, col: 6, char: 'b' },
    ]);

    expect(registerDecorationMock).toHaveBeenCalledTimes(2);

    // Syncing the exact same predictions should preserve existing decorations.
    overlay.sync([
      { row: 12, col: 5, char: 'a' },
      { row: 12, col: 6, char: 'b' },
    ]);

    expect(registerDecorationMock).toHaveBeenCalledTimes(2);
    expect(createdDecorations[0].disposeMock).not.toHaveBeenCalled();
    expect(createdDecorations[1].disposeMock).not.toHaveBeenCalled();
  });

  it('sync() disposes decorations and markers when predictions disappear', () => {
    const overlay = createOverlay();

    overlay.sync([
      { row: 12, col: 5, char: 'a' },
      { row: 12, col: 6, char: 'b' },
    ]);

    const firstDecoration = createdDecorations[0];
    const firstMarker = createdMarkers[0];
    const secondDecoration = createdDecorations[1];
    const secondMarker = createdMarkers[1];

    // Remove the first prediction
    overlay.sync([
      { row: 12, col: 6, char: 'b' },
    ]);

    expect(firstDecoration.disposeMock).toHaveBeenCalledTimes(1);
    expect(firstMarker.disposeMock).toHaveBeenCalledTimes(1);
    expect(secondDecoration.disposeMock).not.toHaveBeenCalled();
    expect(secondMarker.disposeMock).not.toHaveBeenCalled();

    // Calling sync with empty list disposes remaining predictions
    overlay.sync([]);
    expect(secondDecoration.disposeMock).toHaveBeenCalledTimes(1);
    expect(secondMarker.disposeMock).toHaveBeenCalledTimes(1);
  });

  it('sync() replaces decoration when char changes at the same coordinates', () => {
    const overlay = createOverlay();

    overlay.sync([{ row: 12, col: 5, char: 'x' }]);
    expect(registerDecorationMock).toHaveBeenCalledTimes(1);
    const initialDecoration = createdDecorations[0];
    const initialMarker = createdMarkers[0];

    overlay.sync([{ row: 12, col: 5, char: 'y' }]);
    expect(initialDecoration.disposeMock).toHaveBeenCalledTimes(1);
    expect(initialMarker.disposeMock).toHaveBeenCalledTimes(1);
    expect(registerDecorationMock).toHaveBeenCalledTimes(2);
  });

  it('gracefully degrades and leaves no dirty state when registerDecoration returns undefined', () => {
    registerDecorationMock.mockReturnValueOnce(undefined);
    const overlay = createOverlay();

    expect(() => {
      overlay.sync([{ row: 12, col: 5, char: 'z' }]);
    }).not.toThrow();

    // The marker created for the failed decoration should be cleaned up immediately.
    expect(createdMarkers[0].disposeMock).toHaveBeenCalledTimes(1);

    // Subsequent sync should successfully create new decoration if API now succeeds.
    overlay.sync([{ row: 12, col: 5, char: 'z' }]);
    expect(registerDecorationMock).toHaveBeenCalledTimes(2);
  });

  it('gracefully degrades when registerMarker returns undefined or throws', () => {
    registerMarkerMock.mockReturnValueOnce(undefined);
    const overlay = createOverlay();

    expect(() => {
      overlay.sync([{ row: 12, col: 5, char: 'm' }]);
    }).not.toThrow();
    expect(registerDecorationMock).not.toHaveBeenCalled();

    registerMarkerMock.mockImplementationOnce(() => {
      throw new Error('xterm marker failure');
    });

    expect(() => {
      overlay.sync([{ row: 12, col: 5, char: 'm' }]);
    }).not.toThrow();
  });

  it('applies styles and safety attributes to rendered decoration element', () => {
    const overlay = createOverlay({ color: '#123456', background: '#222226', underline: true });

    overlay.sync([{ row: 12, col: 5, char: 'K' }]);
    const decoration = createdDecorations[0];

    expect(registerDecorationMock).toHaveBeenCalledWith(expect.objectContaining({
      backgroundColor: '#222226',
      foregroundColor: '#123456',
    }));

    const element = document.createElement('div');
    decoration.triggerRender(element);

    expect(element.textContent).toBe('K');
    expect(element.style.pointerEvents).toBe('none');
    expect(element.style.userSelect).toBe('none');
    expect(element.style.color).toBe('rgb(18, 52, 86)');
    expect(element.style.backgroundColor).toBe('rgb(34, 34, 38)');
    expect(element.style.textDecoration).toBe('underline');
    expect(element.style.overflow).toBe('hidden');
    expect(element.style.whiteSpace).toBe('pre');
  });

  it('omits invalid non-hex colors from registerDecoration options', () => {
    const overlay = createOverlay({ color: 'inherit', background: 'rgba(0,0,0,0)' });

    overlay.sync([{ row: 12, col: 5, char: 'A' }]);

    const registeredOptions = registerDecorationMock.mock.calls[0][0] as IDecorationOptions;
    expect(registeredOptions.backgroundColor).toBeUndefined();
    expect(registeredOptions.foregroundColor).toBeUndefined();
  });

  it('dynamically refreshes decoration styles when getStyle changes', () => {
    let currentUnderline = false;
    let currentColor = '#111111';
    let currentBackground = '#222222';

    const overlay = createOverlay(() => ({
      color: currentColor,
      background: currentBackground,
      underline: currentUnderline,
    }));

    overlay.sync([{ row: 12, col: 5, char: 'W' }]);
    const decoration = createdDecorations[0];
    const element = document.createElement('div');
    decoration.triggerRender(element);

    expect(element.style.textDecoration).toBe('none');

    // Latency spikes or theme switches:
    currentUnderline = true;
    currentColor = '#999999';
    currentBackground = '#444444';

    // 1. Existing element is refreshed on subsequent sync:
    overlay.sync([{ row: 12, col: 5, char: 'W' }]);
    expect(element.style.textDecoration).toBe('underline');
    expect(element.style.color).toBe('rgb(153, 153, 153)');
    expect(element.style.backgroundColor).toBe('rgb(68, 68, 68)');

    // 2. onRender callback dynamically reads the latest style:
    currentUnderline = false;
    decoration.triggerRender(element);
    expect(element.style.textDecoration).toBe('none');
  });

  it('clear() disposes all active decorations and markers', () => {
    const overlay = createOverlay();

    overlay.sync([
      { row: 12, col: 1, char: '1' },
      { row: 12, col: 2, char: '2' },
      { row: 12, col: 3, char: '3' },
    ]);

    expect(createdDecorations).toHaveLength(3);
    expect(createdMarkers).toHaveLength(3);

    overlay.clear();

    for (const dec of createdDecorations) {
      expect(dec.disposeMock).toHaveBeenCalledTimes(1);
    }
    for (const marker of createdMarkers) {
      expect(marker.disposeMock).toHaveBeenCalledTimes(1);
    }

    // Calling clear again is idempotent
    overlay.clear();
  });

  it('dispose() invokes clear()', () => {
    const overlay = createOverlay();
    overlay.sync([{ row: 12, col: 1, char: 'd' }]);

    overlay.dispose();
    expect(createdDecorations[0].disposeMock).toHaveBeenCalledTimes(1);
    expect(createdMarkers[0].disposeMock).toHaveBeenCalledTimes(1);
  });
});
