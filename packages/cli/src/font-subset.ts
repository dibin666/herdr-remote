/**
 * Cuts the characters a browser needs out of a large font.
 *
 * A CJK face is 16–20 MB — too much to send a phone whole — but a terminal
 * only ever shows a few thousand distinct characters. HarfBuzz's subsetter
 * (the same code Google Fonts slices its CJK families with) produces a small,
 * valid font holding exactly the requested characters: 3,755 common Hanzi in
 * about 1.7 MB and 50 ms, a handful of rare ones in a few KB and milliseconds.
 *
 * The WebAssembly build has no imports and runs synchronously. A loaded face
 * costs its file size twice over (the file and the wasm heap), so the whole
 * instance is dropped after a quiet minute; wasm memory never shrinks, only
 * a new instance gives it back.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

/** How long a loaded font may sit unused before its memory is released. */
const IDLE_RELEASE_MS = 60_000;
/** Never cut more than this many characters in one go. */
const MAX_CODEPOINTS = 16_384;
const HB_MEMORY_MODE_READONLY = 1;

/** The HarfBuzz exports this module calls; every pointer is a heap offset. */
interface HarfBuzz {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, length: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

/** A font file on disk, and which face in it (for collections). */
export interface FontSource {
  path: string;
  index?: number;
}

let wasmModule: WebAssembly.Module | null = null;
function loadModule(): WebAssembly.Module {
  if (!wasmModule) {
    const file = createRequire(import.meta.url).resolve('harfbuzzjs/dist/harfbuzz-subset.wasm');
    wasmModule = new WebAssembly.Module(fs.readFileSync(file));
  }
  return wasmModule;
}

class FontSubsetter {
  readonly idleMs: number;
  private instance: HarfBuzz | null = null;
  /** Loaded faces by source key, in the current instance. */
  private readonly faces = new Map<string, { pointer: number; face: number }>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor({ idleMs = IDLE_RELEASE_MS } = {}) {
    this.idleMs = idleMs;
  }

  exports(): HarfBuzz {
    if (!this.instance) {
      this.instance = new WebAssembly.Instance(loadModule(), {}).exports as unknown as HarfBuzz;
      // An Emscripten reactor: static constructors run here, before any call.
      this.instance._initialize();
    }
    return this.instance;
  }

  face(source: FontSource): number {
    const key = `${source.path}\0${source.index || 0}`;
    const loaded = this.faces.get(key);
    if (loaded) return loaded.face;
    const hb = this.exports();
    const data = fs.readFileSync(source.path);
    const pointer = hb.malloc(data.length);
    if (!pointer) throw new Error('out of memory loading font');
    new Uint8Array(hb.memory.buffer).set(data, pointer);
    const blob = hb.hb_blob_create(pointer, data.length, HB_MEMORY_MODE_READONLY, 0, 0);
    const face = hb.hb_face_create(blob, source.index || 0);
    hb.hb_blob_destroy(blob);
    this.faces.set(key, { pointer, face });
    return face;
  }

  /** A standalone font with just `codepoints` from `source` (`{ path, index }`). */
  subset(source: FontSource, codepoints: number[]): Buffer {
    const hb = this.exports();
    const face = this.face(source);
    const input = hb.hb_subset_input_create_or_fail();
    if (!input) throw new Error('font subsetting is unavailable');
    let result = 0;
    let subsetFace = 0;
    try {
      const set = hb.hb_subset_input_unicode_set(input);
      for (const codepoint of codepoints.slice(0, MAX_CODEPOINTS)) hb.hb_set_add(set, codepoint);
      subsetFace = hb.hb_subset_or_fail(face, input);
      if (!subsetFace) throw new Error('the font could not be subset');
      result = hb.hb_face_reference_blob(subsetFace);
      const length = hb.hb_blob_get_length(result);
      const pointer = hb.hb_blob_get_data(result, 0);
      // Copied out: the heap may grow (and move) on the next call.
      return Buffer.from(new Uint8Array(hb.memory.buffer, pointer, length));
    } finally {
      if (result) hb.hb_blob_destroy(result);
      if (subsetFace) hb.hb_face_destroy(subsetFace);
      hb.hb_subset_input_destroy(input);
      this.scheduleRelease();
    }
  }

  scheduleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.release(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Drop every loaded face and the instance holding them. */
  release(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.faces.clear();
    this.instance = null;
  }
}

export { FontSubsetter, MAX_CODEPOINTS };
