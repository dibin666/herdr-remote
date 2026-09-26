import { describe, it, expect } from 'vitest';
import {
  ANSI_KEYS,
  encodeCtrlKey,
  encodeAltKey,
  encodeKeyWithModifiers,
  encodeStringToBytes,
  isSingleKey,
} from './keyEncoder';

describe('keyEncoder', () => {
  it('encodes standard control characters correctly', () => {
    expect(encodeCtrlKey('c')).toBe('\x03'); // Ctrl+C = ETX (3)
    expect(encodeCtrlKey('C')).toBe('\x03');
    expect(encodeCtrlKey('d')).toBe('\x04'); // Ctrl+D = EOT (4)
    expect(encodeCtrlKey('z')).toBe('\x1a'); // Ctrl+Z = SUB (26)
    expect(encodeCtrlKey('a')).toBe('\x01'); // Ctrl+A = SOH (1)
    expect(encodeCtrlKey('l')).toBe('\x0c'); // Ctrl+L = FF (12)
  });

  it('encodes alt/meta keys correctly', () => {
    expect(encodeAltKey('x')).toBe('\x1bx');
    expect(encodeAltKey('f')).toBe('\x1bf');
  });

  it('encodes key combinations with active modifiers', () => {
    expect(encodeKeyWithModifiers('c', { ctrl: true })).toBe('\x03');
    expect(encodeKeyWithModifiers('x', { alt: true })).toBe('\x1bx');
    expect(encodeKeyWithModifiers('a', { shift: true })).toBe('A');
    expect(encodeKeyWithModifiers('c', { ctrl: true, alt: true })).toBe('\x1b\x03');
  });

  it('encodes string to UTF-8 Uint8Array', () => {
    const bytes = encodeStringToBytes('hello\r\n');
    expect(bytes.length).toBe(7);
    expect(bytes[0]).toBe(104); // 'h'
    expect(bytes[5]).toBe(13); // '\r'
    expect(bytes[6]).toBe(10); // '\n'
  });

  it('provides valid ANSI sequences for navigation and function keys', () => {
    expect(ANSI_KEYS.ESC).toBe('\x1b');
    expect(ANSI_KEYS.UP).toBe('\x1b[A');
    expect(ANSI_KEYS.DOWN).toBe('\x1b[B');
    expect(ANSI_KEYS.RIGHT).toBe('\x1b[C');
    expect(ANSI_KEYS.LEFT).toBe('\x1b[D');
    expect(ANSI_KEYS.PAGE_UP).toBe('\x1b[5~');
    expect(ANSI_KEYS.PAGE_DOWN).toBe('\x1b[6~');
    expect(ANSI_KEYS.F1).toBe('\x1bOP');
    expect(ANSI_KEYS.F5).toBe('\x1b[15~');
  });
});

describe('encodeKeyWithModifiers on special keys', () => {
  // Each sequence below was checked against Herdr 0.9.1: it either reaches the
  // pane as sent, or is what Herdr turns into the pane's own encoding.
  it.each([
    ['ctrl+left', ANSI_KEYS.LEFT, { ctrl: true }, '\x1b[1;5D'],
    ['shift+up', ANSI_KEYS.UP, { shift: true }, '\x1b[1;2A'],
    ['alt+right', ANSI_KEYS.RIGHT, { alt: true }, '\x1b[1;3C'],
    ['ctrl+shift+end', ANSI_KEYS.END, { ctrl: true, shift: true }, '\x1b[1;6F'],
    ['ctrl+home via SS3', '\x1bOH', { ctrl: true }, '\x1b[1;5H'],
    ['shift+f1', ANSI_KEYS.F1, { shift: true }, '\x1b[1;2P'],
    ['shift+f5', ANSI_KEYS.F5, { shift: true }, '\x1b[15;2~'],
    ['ctrl+page up', ANSI_KEYS.PAGE_UP, { ctrl: true }, '\x1b[5;5~'],
    ['shift+tab', ANSI_KEYS.TAB, { shift: true }, '\x1b[Z'],
    ['alt+tab', ANSI_KEYS.TAB, { alt: true }, '\x1b\t'],
    ['ctrl+tab', ANSI_KEYS.TAB, { ctrl: true }, '\x1b[9;5u'],
    ['ctrl+shift+tab', ANSI_KEYS.SHIFT_TAB, { ctrl: true }, '\x1b[9;6u'],
    ['shift+enter', ANSI_KEYS.ENTER, { shift: true }, '\x1b[13;2u'],
    ['alt+enter', ANSI_KEYS.ENTER, { alt: true }, '\x1b\r'],
    ['ctrl+enter', ANSI_KEYS.ENTER, { ctrl: true }, '\x1b[13;5u'],
    ['ctrl+backspace', ANSI_KEYS.BACKSPACE, { ctrl: true }, '\x08'],
    ['alt+backspace', ANSI_KEYS.BACKSPACE, { alt: true }, '\x1b\x7f'],
    ['alt+escape', ANSI_KEYS.ESC, { alt: true }, '\x1b\x1b'],
    ['shift+escape', ANSI_KEYS.ESC, { shift: true }, '\x1b[27;2u'],
  ])('%s', (_name, key, modifiers, expected) => {
    expect(encodeKeyWithModifiers(key, modifiers)).toBe(expected);
  });

  it('leaves a key alone when no modifier is held', () => {
    expect(encodeKeyWithModifiers(ANSI_KEYS.LEFT, {})).toBe(ANSI_KEYS.LEFT);
    expect(encodeKeyWithModifiers('x', { ctrl: false })).toBe('x');
  });
});

describe('isSingleKey', () => {
  it('accepts one character or one special-key sequence', () => {
    for (const key of [
      'a',
      '你',
      '\r',
      '\x7f',
      '\x1b',
      ANSI_KEYS.LEFT,
      '\x1bOA',
      ANSI_KEYS.F1,
      ANSI_KEYS.F5,
      ANSI_KEYS.SHIFT_TAB,
    ]) {
      expect(isSingleKey(key)).toBe(true);
    }
  });

  it('rejects pastes, IME commits and mouse reports', () => {
    for (const data of ['ab', '你好', 'ls\r', '\x1b[<0;1;1M', '\x1b[I']) {
      expect(isSingleKey(data)).toBe(false);
    }
  });
});
