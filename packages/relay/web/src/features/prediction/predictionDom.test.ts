import type { Terminal } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { createTestScreen } from '@/test/helpers/screenFixture';
import { PredictionLayer } from './predictionPaint';

it('keeps predictions visible through DOM fallback, using cell geometry and learned styles', () => {
  const screen = createTestScreen(80, 12);
  screen.setCursor(9, 5);
  const element = document.createElement('div');
  element.className = 'xterm-screen';
  const color = { css: '#ffffff', rgba: 0xffffffff };
  const dispose = vi.fn();
  const term = Object.assign(screen, {
    onRender: () => ({ dispose }),
    onScroll: () => ({ dispose }),
    _core: {
      screenElement: element,
      coreService: {},
      optionsService: {
        rawOptions: {
          fontFamily: 'monospace',
          fontSize: 16,
          fontWeight: 'normal',
          fontWeightBold: 'bold',
          cursorStyle: 'block',
        },
      },
      _bufferService: { buffer: {} },
      _charSizeService: {},
      _coreBrowserService: { isFocused: true },
      _themeService: {
        colors: {
          foreground: color,
          background: { ...color, css: '#000000' },
          cursor: color,
          cursorAccent: color,
          ansi: [],
        },
      },
      _renderService: {
        setRenderer: vi.fn(),
        dimensions: { css: { cell: { width: 8, height: 16 } } },
      },
    },
  }) as unknown as Terminal;
  Object.assign(term.buffer.active, { viewportY: 0 });
  const layer = new PredictionLayer({ getTerminal: () => term, isCursorHidden: () => false });
  layer.attach(null);
  layer.sync([
    {
      row: 5,
      col: 9,
      char: '你',
      width: 2,
      kind: 'char',
      style: { fg: 0x0300ff00, bg: 0, ext: 0 },
    },
    { row: 5, col: 11, char: ' ', width: 1, kind: 'caret' },
  ]);
  const cell = Array.from(element.querySelectorAll('span')).find(
    (node) => node.textContent === '你',
  );
  expect(cell).toBeDefined();
  expect(cell?.style.left).toBe('72px');
  expect(cell?.style.top).toBe('80px');
  expect(cell?.style.width).toBe('16px');
  expect(cell?.style.color).toBe('rgb(0, 255, 0)');
  expect(screen.getLine(5)?.getCell(9)?.getChars()).toBe('');
  screen.write(5, 9, 'x');
  screen.setCursor(10, 5);
  layer.sync([
    { row: 5, col: 9, char: ' ', width: 1, kind: 'erase' },
    { row: 5, col: 9, char: ' ', width: 1, kind: 'caret' },
  ]);
  expect(
    Array.from(element.querySelectorAll('span')).some((node) => node.textContent === 'x'),
  ).toBe(false);
  layer.clear();
  expect(element.querySelectorAll('span')).toHaveLength(0);
  layer.dispose();
  expect(element.childElementCount).toBe(0);
  expect(dispose).toHaveBeenCalledTimes(2);
});
