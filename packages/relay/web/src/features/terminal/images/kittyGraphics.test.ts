import { describe, expect, it, vi } from 'vitest';
import { KittyGraphics } from './kittyGraphics';

const CURSOR = { col: 3, line: 10 };
const PNG_B64 = 'aGVsbG8='; // "hello" — contents don't matter to a stub decoder
// Interior chunks carry no padding; only the last may end in `=`.
const CHUNK_1 = 'aGVsbG8v';
const CHUNK_2 = 'aGVsbG8v';
const CHUNK_LAST = 'bGQ=';

function makeGraphics() {
  const changes: number[] = [];
  const graphics = new KittyGraphics(
    async () => ({ width: 4, height: 4 }),
    () => {
      changes.push(1);
    },
  );
  return { graphics, changes };
}

describe('KittyGraphics chunked transfers', () => {
  it('joins m=1 chunks before decoding', async () => {
    const { graphics } = makeGraphics();
    graphics.handle(`a=t,t=d,f=100,i=7,m=1;${CHUNK_1}`, CURSOR);
    graphics.handle(`m=1;${CHUNK_2}`, CURSOR);
    graphics.handle(`m=0;${CHUNK_LAST}`, CURSOR);
    await vi.waitFor(() => {
      expect(graphics.image(7)).not.toBeNull();
    });
    expect(graphics.image(7)?.width).toBe(4);
  });

  it('drops an interrupted transfer instead of feeding it a foreign command', async () => {
    const decode = vi.fn(async () => ({ width: 4, height: 4 }));
    const graphics = new KittyGraphics(decode, () => {});
    graphics.handle(`a=t,t=d,f=100,i=7,m=1;${PNG_B64}`, CURSOR);
    // A placement command arriving mid-transfer is its own command, not data.
    graphics.handle('a=p,i=9,p=1,c=2,r=2;', CURSOR);
    // A new transfer starting while the old one was open replaces it cleanly.
    graphics.handle(`a=t,t=d,f=100,i=9;${PNG_B64}`, CURSOR);
    await vi.waitFor(() => {
      expect(graphics.image(9)).not.toBeNull();
    });
    expect(graphics.image(7)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('places and deletes placements the way Herdr drives them', async () => {
    const { graphics } = makeGraphics();
    graphics.handle(`a=t,t=d,f=100,i=7;${PNG_B64}`, CURSOR);
    graphics.handle('a=p,i=7,p=2,c=10,r=5;', CURSOR);
    expect(graphics.placements()).toHaveLength(1);
    expect(graphics.placements()[0]).toMatchObject({ imageId: 7, col: 3, line: 10 });
    graphics.handle('a=d,d=i,i=7,p=2;', CURSOR);
    expect(graphics.placements()).toHaveLength(0);
    await vi.waitFor(() => {
      expect(graphics.image(7)).not.toBeNull();
    });
  });

  it('forgets an image that fails to decode', async () => {
    const graphics = new KittyGraphics(
      async () => {
        throw new Error('bad png');
      },
      () => {},
    );
    graphics.handle(`a=t,t=d,f=100,i=7;${PNG_B64}`, CURSOR);
    graphics.handle('a=p,i=7,p=2,c=10,r=5;', CURSOR);
    await vi.waitFor(() => {
      expect(graphics.image(7)).toBeNull();
    });
    expect(graphics.placements()).toHaveLength(1);
  });
});
