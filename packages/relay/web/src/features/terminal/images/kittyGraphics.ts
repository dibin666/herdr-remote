/**
 * The part of the Kitty graphics protocol Herdr speaks to its outer terminal:
 * images sent inline (`t=d`) as RGB, RGBA or PNG, optionally zlib-compressed
 * and in chunks; placements, which Herdr re-sends at absolute positions
 * whenever its layout moves them; and deletions.
 *
 * Herdr asks for no replies (`q=2`), so none are sent. Images on the host's
 * disk or in its shared memory (`t=f`, `t=t`, `t=s`) cannot be read from a
 * browser and are ignored, as are animation frames.
 */

/** Pixels ready to draw; `ImageBitmap` in the browser. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
}

export interface ImageFormat {
  /** 24 (RGB), 32 (RGBA) or 100 (PNG). */
  format: number;
  /** Pixel size the sender declared; PNG carries its own. */
  width: number;
  height: number;
  compressed: boolean;
}

export type ImageDecoder<T extends DecodedImage> = (
  bytes: Uint8Array,
  format: ImageFormat,
) => Promise<T>;

export interface Placement {
  imageId: number;
  /** Column and absolute buffer line of the top-left cell. */
  col: number;
  line: number;
  /** Cells to fill; 0 means follow the image's own size. */
  cols: number;
  rows: number;
  /** Source rectangle in image pixels; a width or height of 0 runs to the edge. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Offset into the top-left cell, in pixels. */
  offsetX: number;
  offsetY: number;
  z: number;
}

export interface Cursor {
  col: number;
  line: number;
}

/**
 * What a phone can hold. Herdr frees what it no longer shows; this only stops
 * a sender that never does from growing the tab without bound.
 */
const STORAGE_LIMIT_BYTES = 192 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set([24, 32, 100]);

interface StoredImage<T> {
  decoded: T | null;
  bytes: number;
}

type Keys = Map<string, string>;

export class KittyGraphics<T extends DecodedImage> {
  private readonly images = new Map<number, StoredImage<T>>();
  private readonly placementsByKey = new Map<string, Placement>();
  /** The first chunk's keys and every chunk's payload, until `m=0`. */
  private pending: { keys: Keys; payload: string[] } | null = null;
  private nextAnonymous = -1;
  private generation = 0;

  constructor(
    private readonly decode: ImageDecoder<T>,
    private readonly onChange: () => void,
  ) {}

  /** One command: control data, then `;` and the payload. */
  handle(data: string, cursor: Cursor): void {
    const separator = data.indexOf(';');
    const control = separator === -1 ? data : data.slice(0, separator);
    const payload = separator === -1 ? '' : data.slice(separator + 1);
    const keys: Keys = new Map();
    for (const pair of control.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) keys.set(pair.slice(0, eq), pair.slice(eq + 1));
    }

    if (this.pending) {
      // A continuation carries only `m` (and perhaps `q`); its keys are the first chunk's.
      this.pending.payload.push(payload);
      if (keys.get('m') === '1') return;
      const { keys: first, payload: parts } = this.pending;
      this.pending = null;
      this.run(first, parts.join(''), cursor);
      return;
    }
    if (keys.get('m') === '1') {
      this.pending = { keys, payload: [payload] };
      return;
    }
    this.run(keys, payload, cursor);
  }

  placements(): Placement[] {
    return [...this.placementsByKey.values()].sort((a, b) => a.z - b.z);
  }

  image(id: number): T | null {
    return this.images.get(id)?.decoded ?? null;
  }

  /** The other screen buffer has its own images; the ones placed here are gone from view. */
  clearPlacements(): void {
    if (!this.placementsByKey.size) return;
    this.placementsByKey.clear();
    this.onChange();
  }

  reset(): void {
    this.generation += 1;
    this.images.clear();
    this.placementsByKey.clear();
    this.pending = null;
    this.onChange();
  }

  private run(keys: Keys, payload: string, cursor: Cursor): void {
    const action = keys.get('a') ?? 't';
    if (action === 't' || action === 'T') {
      const id = this.transmit(keys, payload);
      if (action === 'T' && id !== null) this.place(id, keys, cursor);
    } else if (action === 'p') {
      const id = num(keys, 'i');
      if (this.images.has(id)) this.place(id, keys, cursor);
    } else if (action === 'd') {
      this.delete(keys);
    }
  }

  private transmit(keys: Keys, payload: string): number | null {
    const medium = keys.get('t') ?? 'd';
    const format = num(keys, 'f') || 32;
    if (medium !== 'd' || !SUPPORTED_FORMATS.has(format)) return null;
    const id = num(keys, 'i') || this.nextAnonymous--;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(payload);
    } catch {
      // A corrupt payload is one lost image, not a broken terminal.
      return null;
    }
    const image: StoredImage<T> = { decoded: null, bytes: bytes.length };
    this.images.delete(id);
    this.images.set(id, image);
    this.evict();
    const generation = this.generation;
    this.decode(bytes, {
      format,
      width: num(keys, 's'),
      height: num(keys, 'v'),
      compressed: keys.get('o') === 'z',
    }).then(
      (decoded) => {
        if (this.generation !== generation || this.images.get(id) !== image) return;
        image.decoded = decoded;
        image.bytes = decoded.width * decoded.height * 4;
        this.evict();
        this.onChange();
      },
      (error: unknown) => {
        console.debug('Kitty graphics: image could not be decoded:', error);
        if (this.images.get(id) === image) this.images.delete(id);
      },
    );
    return id;
  }

  private place(imageId: number, keys: Keys, cursor: Cursor): void {
    const placementId = num(keys, 'p');
    // Placing the same image and placement id again moves it; without an id
    // every placement is a new one.
    const key = placementId ? `${imageId}:${placementId}` : `${imageId}:${this.nextAnonymous--}`;
    this.placementsByKey.delete(key);
    this.placementsByKey.set(key, {
      imageId,
      col: cursor.col,
      line: cursor.line,
      cols: num(keys, 'c'),
      rows: num(keys, 'r'),
      sx: num(keys, 'x'),
      sy: num(keys, 'y'),
      sw: num(keys, 'w'),
      sh: num(keys, 'h'),
      offsetX: num(keys, 'X'),
      offsetY: num(keys, 'Y'),
      z: num(keys, 'z'),
    });
    this.onChange();
  }

  private delete(keys: Keys): void {
    const what = keys.get('d') ?? 'a';
    const free = what === what.toUpperCase();
    const imageId = num(keys, 'i');
    const placementId = num(keys, 'p');
    const touched = new Set<number>();
    for (const [key, placement] of this.placementsByKey) {
      const matches =
        what.toLowerCase() === 'a' ||
        (what.toLowerCase() === 'i' &&
          placement.imageId === imageId &&
          (!placementId || key === `${imageId}:${placementId}`));
      if (!matches) continue;
      this.placementsByKey.delete(key);
      touched.add(placement.imageId);
    }
    if (free) {
      if (what === 'I' && !placementId) touched.add(imageId);
      if (what === 'A') for (const id of this.images.keys()) touched.add(id);
      for (const id of touched) if (!this.isPlaced(id)) this.images.delete(id);
    }
    this.onChange();
  }

  private isPlaced(imageId: number): boolean {
    for (const placement of this.placementsByKey.values()) {
      if (placement.imageId === imageId) return true;
    }
    return false;
  }

  /** Drops the oldest images nothing shows until the store fits its budget. */
  private evict(): void {
    let total = 0;
    for (const image of this.images.values()) total += image.bytes;
    for (const [id, image] of this.images) {
      if (total <= STORAGE_LIMIT_BYTES) return;
      if (this.isPlaced(id)) continue;
      this.images.delete(id);
      total -= image.bytes;
    }
  }
}

function num(keys: Keys, key: string): number {
  const value = Number(keys.get(key));
  return Number.isFinite(value) ? value : 0;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
