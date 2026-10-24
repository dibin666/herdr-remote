import type { ImageFormat } from './kittyGraphics';

/** Turns a Kitty graphics payload into a bitmap the image layer can draw. */
export async function decodeImage(bytes: Uint8Array, format: ImageFormat): Promise<ImageBitmap> {
  const data = format.compressed ? await inflate(bytes) : bytes;
  if (format.format === 100) {
    return createImageBitmap(new Blob([data as BlobPart], { type: 'image/png' }));
  }
  const { width, height } = format;
  const channels = format.format === 24 ? 3 : 4;
  if (!width || !height || data.length < width * height * channels) {
    throw new Error(`${data.length} bytes do not hold a ${width}x${height} image`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    rgba.set(data.subarray(0, rgba.length));
  } else {
    for (let src = 0, dst = 0; dst < rgba.length; src += 3, dst += 4) {
      rgba[dst] = data[src];
      rgba[dst + 1] = data[src + 1];
      rgba[dst + 2] = data[src + 2];
      rgba[dst + 3] = 255;
    }
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
