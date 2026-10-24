import { describe, expect, it, vi } from 'vitest';
import { type DecodedImage, type ImageFormat, KittyGraphics } from './kittyGraphics';

interface FakeImage extends DecodedImage {
  bytes: number[];
  format: ImageFormat;
}

function setup() {
  const decoded: Array<{ bytes: number[]; format: ImageFormat }> = [];
  const decode = vi.fn(async (bytes: Uint8Array, format: ImageFormat): Promise<FakeImage> => {
    decoded.push({ bytes: [...bytes], format });
    return { width: format.width || 4, height: format.height || 2, bytes: [...bytes], format };
  });
  const onChange = vi.fn();
  const graphics = new KittyGraphics(decode, onChange);
  return { graphics, decode, decoded, onChange };
}

const at = (col: number, line: number) => ({ col, line });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('KittyGraphics', () => {
  it('decodes an image Herdr sends in chunks, then places it where the cursor is', async () => {
    const { graphics, decoded } = setup();
    // What Herdr 0.9.5 sent for a 2x1 RGBA image.
    graphics.handle('a=t,t=d,f=32,s=2,v=1,i=7,q=2,m=1;AQID', at(0, 0));
    graphics.handle('m=0;BAUGBwg=', at(0, 0));
    await flush();
    expect(decoded).toEqual([
      {
        bytes: [1, 2, 3, 4, 5, 6, 7, 8],
        format: { format: 32, width: 2, height: 1, compressed: false },
      },
    ]);
    expect(graphics.image(7)).toMatchObject({ width: 2, height: 1 });

    graphics.handle('a=p,i=7,p=3,c=10,r=5,z=0,C=1,q=2,w=2,h=1;', at(26, 2));
    expect(graphics.placements()).toEqual([
      {
        imageId: 7,
        col: 26,
        line: 2,
        cols: 10,
        rows: 5,
        sx: 0,
        sy: 0,
        sw: 2,
        sh: 1,
        offsetX: 0,
        offsetY: 0,
        z: 0,
      },
    ]);
  });

  it('moves a placement placed again under the same id', () => {
    const { graphics } = setup();
    graphics.handle('a=t,f=100,i=1;AAAA', at(0, 0));
    graphics.handle('a=p,i=1,p=2;', at(1, 1));
    graphics.handle('a=p,i=1,p=2;', at(5, 9));
    expect(graphics.placements().map(({ col, line }) => [col, line])).toEqual([[5, 9]]);
  });

  it('places nothing for an image it never received', () => {
    const { graphics } = setup();
    graphics.handle('a=p,i=9,p=1;', at(0, 0));
    expect(graphics.placements()).toEqual([]);
  });

  it('transmits and places in one command', () => {
    const { graphics } = setup();
    graphics.handle('a=T,f=100,i=4,c=3;AAAA', at(2, 3));
    expect(graphics.placements()).toMatchObject([{ imageId: 4, col: 2, line: 3, cols: 3 }]);
  });

  it('deletes one placement, and frees the image when asked to', () => {
    const { graphics } = setup();
    graphics.handle('a=t,f=100,i=1;AAAA', at(0, 0));
    graphics.handle('a=p,i=1,p=1;', at(0, 0));
    graphics.handle('a=p,i=1,p=2;', at(0, 5));
    graphics.handle('a=d,d=i,i=1,p=1,q=2;', at(0, 0));
    expect(graphics.placements().map((placement) => placement.line)).toEqual([5]);
    graphics.handle('a=d,d=I,i=1,q=2;', at(0, 0));
    expect(graphics.placements()).toEqual([]);
    graphics.handle('a=p,i=1,p=1;', at(0, 0));
    expect(graphics.placements()).toEqual([]);
  });

  it('ignores images it cannot read from a browser', () => {
    const { graphics, decode } = setup();
    graphics.handle('a=T,t=f,f=100,i=1;L3RtcC94LnBuZw==', at(0, 0));
    expect(decode).not.toHaveBeenCalled();
    expect(graphics.placements()).toEqual([]);
  });

  it('forgets placements on a buffer switch and everything on reset', async () => {
    const { graphics } = setup();
    graphics.handle('a=T,f=100,i=1,p=1;AAAA', at(0, 0));
    await flush();
    graphics.clearPlacements();
    expect(graphics.placements()).toEqual([]);
    expect(graphics.image(1)).not.toBeNull();
    graphics.reset();
    expect(graphics.image(1)).toBeNull();
  });

  it('drops a decode that finishes after a reset', async () => {
    const { graphics } = setup();
    graphics.handle('a=t,f=100,i=1;AAAA', at(0, 0));
    graphics.reset();
    await flush();
    expect(graphics.image(1)).toBeNull();
  });
});
