import { describe, expect, it } from 'vitest';
import { createKittyApcRewriter, KITTY_GRAPHICS_OSC } from './kittyApc';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OSC = `\x1b]${KITTY_GRAPHICS_OSC};`;

function run(chunks: string[]): string {
  const rewrite = createKittyApcRewriter();
  return chunks.map((chunk) => decoder.decode(rewrite(encoder.encode(chunk)))).join('');
}

describe('createKittyApcRewriter', () => {
  it('turns a graphics APC into the OSC the image layer handles', () => {
    expect(run(['ab\x1b_Ga=p,i=1;\x1b\\cd'])).toBe(`ab${OSC}a=p,i=1;\x1b\\cd`);
  });

  it('hands back output without graphics unchanged', () => {
    const rewrite = createKittyApcRewriter();
    const chunk = encoder.encode('\x1b[31mred\x1b[0m\x1b_Xother\x1b\\');
    expect(rewrite(chunk)).toBe(chunk);
  });

  it('finds an introducer split across chunks', () => {
    expect(run(['a\x1b', '_Gm=0;\x1b\\'])).toBe(`a${OSC}m=0;\x1b\\`);
    expect(run(['a\x1b_', 'Gm=0;\x1b\\'])).toBe(`a${OSC}m=0;\x1b\\`);
  });

  it('releases a held escape that turns out to start something else', () => {
    expect(run(['a\x1b', '[1m'])).toBe('a\x1b[1m');
    expect(run(['a\x1b_', 'Xb'])).toBe('a\x1b_Xb');
  });

  it('rewrites every command in a chunk', () => {
    expect(run(['\x1b_Ga=t,m=1;AA\x1b\\\x1b_Gm=0;BB\x1b\\'])).toBe(
      `${OSC}a=t,m=1;AA\x1b\\${OSC}m=0;BB\x1b\\`,
    );
  });
});
