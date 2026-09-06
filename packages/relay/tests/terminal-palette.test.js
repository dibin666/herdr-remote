'use strict';

// A palette crosses the wire from a workstation into a browser's renderer, so
// the relay treats it as untrusted input: only plain hex colors in the exact
// shape xterm understands may pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeTerminalPalette, ANSI_PALETTE_KEYS } = require('../src/stream-frame');

const FULL_ANSI = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
};

test('a complete host palette passes through unchanged', () => {
  const palette = sanitizeTerminalPalette({
    background: '#222226',
    foreground: '#FFFFFF',
    cursor: '#ffffff',
    ansi: FULL_ANSI,
  });

  assert.equal(palette.background, '#222226');
  assert.equal(palette.foreground, '#ffffff');
  assert.deepEqual(Object.keys(palette.ansi), ANSI_PALETTE_KEYS);
  assert.equal(palette.ansi.red, '#cc0000');
});

test('a host that reports only some colors keeps only those', () => {
  const palette = sanitizeTerminalPalette({ background: '#101014', foreground: 'not-a-color' });
  assert.deepEqual(palette, { background: '#101014' });
});

test('a partial ANSI ramp is dropped rather than mixed with the browser defaults', () => {
  const { black, red } = FULL_ANSI;
  const palette = sanitizeTerminalPalette({ background: '#101014', ansi: { black, red } });
  assert.equal(palette.ansi, undefined);
  assert.equal(palette.background, '#101014');
});

test('anything that is not a palette of hex colors is refused', () => {
  assert.equal(sanitizeTerminalPalette(null), null);
  assert.equal(sanitizeTerminalPalette('#ffffff'), null);
  assert.equal(sanitizeTerminalPalette([]), null);
  assert.equal(sanitizeTerminalPalette({}), null);
  assert.equal(sanitizeTerminalPalette({ background: 'red; }' }), null);
  assert.equal(sanitizeTerminalPalette({ background: 'javascript:alert(1)' }), null);
  assert.equal(sanitizeTerminalPalette({ background: { toString: () => '#ffffff' } }), null);
});
