import { describe, expect, it } from 'vitest';
import { predictableWidth } from './wideChars';

const width = (ch: string) => predictableWidth(ch.codePointAt(0)!);

describe('predictableWidth', () => {
  it.each([
    [' ', 1],
    ['a', 1],
    ['~', 1],
    ['你', 2],
    ['好', 2],
    ['。', 2],
    ['，', 2],
    ['！', 2],
    ['Ａ', 2],
    ['あ', 2],
    ['カ', 2],
    ['한', 2],
    ['𠀀', 2],
    ['　', 2],
  ])('gives %j a width of %i', (ch, expected) => {
    expect(width(ch)).toBe(expected);
  });

  it.each([
    ['\t'],
    ['\x7f'],
    ['é'],
    ['—'],
    ['…'],
    ['😀'],
    ['✔'],
    ['〰'],
    ['〽'],
    ['゙'],
    ['〿'],
    [' '],
  ])('refuses %j, whose width terminals disagree on or which is not text', (ch) => {
    expect(width(ch)).toBe(0);
  });
});
