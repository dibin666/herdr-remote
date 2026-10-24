import { Terminal } from '@xterm/headless';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { attachTerminalImages } from './attachTerminalImages';

// The real parser, not the global xterm mock: the image layer is only as good
// as its view of the cursor when Herdr's commands are parsed.
function setup() {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const decoded: number[] = [];
  const images = attachTerminalImages(term as unknown as BrowserTerminal, async (bytes) => {
    decoded.push(bytes.length);
    return { width: 1, height: 1 } as ImageBitmap;
  });
  const write = (text: string) =>
    new Promise<void>((resolve) =>
      term.write(images.rewrite(new TextEncoder().encode(text)), resolve),
    );
  return { term, images, decoded, write };
}

describe('attachTerminalImages', () => {
  it('receives the images Herdr sends, split across chunks, without printing them', async () => {
    const { term, images, decoded, write } = setup();
    await write('\x1b[?1049h\x1b_Ga=t,t=d,f=32,s=1,v=1,i=5,q=2,m=1;AAAA\x1b');
    await write('\\\x1b_Gm=0;\x1b\\\x1b[3;27H\x1b_Ga=p,i=5,p=1,c=10,r=5,C=1,q=2;\x1b\\');
    expect(decoded).toEqual([3]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('');
    expect(term.buffer.active.cursorY).toBe(2);
    expect(term.buffer.active.cursorX).toBe(26);
    expect(images.placements()).toMatchObject([{ imageId: 5, col: 26, line: 2, cols: 10 }]);
  });

  it('forgets placements when Herdr leaves the alternate screen', async () => {
    const { images, write } = setup();
    await write('\x1b[?1049h\x1b_Ga=T,f=100,i=1,p=1;AAAA\x1b\\');
    expect(images.placements()).toHaveLength(1);
    await write('\x1b[?1049l');
    expect(images.placements()).toEqual([]);
  });
});
