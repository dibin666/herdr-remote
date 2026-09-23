import { describe, expect, it } from 'vitest';
import { classifyInput, isLoneEscape } from '../utils/inputClassifier';

describe('classifyInput', () => {
  it.each([
    ['\x1b[<35;10;5M', 'hover with no button'],
    ['\x1b[<35;10;5M\x1b[<35;11;5M', 'a burst of hover reports'],
    ['\x1b[I', 'focus in'],
    ['\x1b[O', 'focus out'],
    ['\x1b[12;40R', 'cursor position report'],
    ['\x1b[?64;1;2c', 'primary device attributes'],
    ['\x1b]11;rgb:1e1e/1e1e/2e2e\x07', 'an OSC colour reply'],
    ['\x1b[?2026;2$y', 'a DECRQM reply'],
  ])('treats %j (%s) as passive', (data) => {
    expect(classifyInput(data)).toBe('passive');
  });

  it.each([
    ['\x1b[<0;10;5M', 'left press'],
    ['\x1b[<0;10;5m', 'left release'],
    ['\x1b[<32;11;5M', 'drag with the left button'],
    ['\x1b[<64;10;5M', 'wheel up'],
    ['\x1b[M #!', 'an X10 click'],
    ['\x1b[<35;10;5M\x1b[<0;10;5M', 'hover then click'],
  ])('treats %j (%s) as a pointer', (data) => {
    expect(classifyInput(data)).toBe('pointer');
  });

  it.each([
    ['a'], ['你好'], ['\r'], ['\x1b'], ['\x1b[A'], ['\x1bOA'], ['\x1b[Z'], ['\x1b[1;5D'], ['\x1b[15~'],
    ['\x1b[1;2R'], // a modified F3 looks like a cursor report but is a key
    ['\x1bb'],
  ])('treats %j as keys', (data) => {
    expect(classifyInput(data)).toBe('keys');
  });
});

describe('isLoneEscape', () => {
  it('matches only a bare Escape', () => {
    expect(isLoneEscape('\x1b')).toBe(true);
    expect(isLoneEscape('\x1b[A')).toBe(false);
    expect(isLoneEscape('\x1b\x1b')).toBe(false);
  });
});
