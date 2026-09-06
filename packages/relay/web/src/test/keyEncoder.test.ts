import { describe, it, expect } from 'vitest';
import {
  ANSI_KEYS,
  encodeCtrlKey,
  encodeAltKey,
  encodeKeyWithModifiers,
  encodeStringToBytes,
} from '../protocol/keyEncoder';

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
    expect(bytes[5]).toBe(13);  // '\r'
    expect(bytes[6]).toBe(10);  // '\n'
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
