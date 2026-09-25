import type { HostFontFace, HostFontStyle, HostFontSubsetSource, HostTerminalFont } from '../types/protocol';

/**
 * Bringing the workstation's terminal font to this browser.
 *
 * The host reports a family and, when it can, the files behind it (see
 * `packages/cli/src/terminal-font.js`). A device that already has the family
 * uses it by name. One that does not — a phone, nearly always — fetches the
 * files once, with the user's consent, and keeps them in IndexedDB; they are
 * then registered as FontFaces under an alias derived from their hash.
 *
 * Nothing here uses `crypto.subtle`: a relay on the LAN is plain HTTP, and
 * there the API does not exist. The host's hashes are cache keys, and the
 * browser's own font sanitiser is what vets the bytes.
 */

/** Raw bytes in one `host_font_chunk`; matches the relay's constant. */
export const HOST_FONT_CHUNK_BYTES = 256 * 1024;
/** Slices requested ahead; the relay allows a few more, never more. */
const CHUNKS_IN_FLIGHT = 2;

const FACE_DESCRIPTORS: Record<HostFontStyle, FontFaceDescriptors> = {
  regular: { weight: '400', style: 'normal' },
  bold: { weight: '700', style: 'normal' },
  italic: { weight: '400', style: 'italic' },
  boldItalic: { weight: '700', style: 'italic' },
};

/** The same family with the same files is the same font; its size is not. */
export function hostFontFingerprint(font: HostTerminalFont | null | undefined): string | null {
  if (!font) return null;
  return [
    font.family,
    ...font.faces.map((face) => face.sha256),
    ...(font.subsets || []).map((source) => source.sha256),
  ].join('|');
}

/**
 * The FontFace family the fetched files are registered under. Named after the
 * regular file's hash rather than the real family, so a new version of the
 * font is a new family (and a new cell measurement) instead of a stale one.
 */
export function hostFontAlias(font: HostTerminalFont | null | undefined): string | null {
  const regular = font?.faces.find((face) => face.style === 'regular');
  return regular ? `Herdr Host ${regular.sha256.slice(0, 12)}` : null;
}

export function hostFontBytes(font: HostTerminalFont | null | undefined): number {
  return font ? font.faces.reduce((sum, face) => sum + face.bytes, 0) : 0;
}

/** `9.6 MB`, `740 KB`. */
export function formatFontBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Whether this device can already draw `family`.
 *
 * A face this device has changes the width of a sample set against both a
 * serif and a sans-serif fallback; one it lacks falls through to them and
 * measures the same. Bundled webfonts use `Herdr …` aliases, and fetched
 * files `Herdr Host …`, so neither can make a real family look installed.
 */
export function isFontInstalled(family: string): boolean {
  if (typeof document === 'undefined') return false;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
  if (!context) return false;
  const sample = 'mmmmmmmmmmlli10OQ@#WWww';
  for (const generic of ['serif', 'sans-serif']) {
    context.font = `72px ${generic}`;
    const baseline = context.measureText(sample).width;
    context.font = `72px "${family}", ${generic}`;
    if (context.measureText(sample).width !== baseline) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ cache */

const DB_NAME = 'herdr-remote-fonts';
const STORE = 'faces';
/** Cut fonts, keyed `<source sha>:<subset sha>`. */
const SUBSET_STORE = 'subsets';
/** Private browsing or a blocked IndexedDB still caches for this page. */
const memoryCache = new Map<string, ArrayBuffer>();
const memorySubsets = new Map<string, CachedSubset[]>();

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        if (!request.result.objectStoreNames.contains(SUBSET_STORE)) request.result.createObjectStore(SUBSET_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readCachedFace(sha256: string): Promise<ArrayBuffer | null> {
  const remembered = memoryCache.get(sha256);
  if (remembered) return remembered;
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(sha256);
      request.onsuccess = () => {
        const value = request.result;
        resolve(value instanceof ArrayBuffer ? value : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

export async function writeCachedFace(sha256: string, data: ArrayBuffer): Promise<void> {
  memoryCache.set(sha256, data);
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(data, sha256);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}

export interface CachedSubset {
  subsetSha: string;
  data: ArrayBuffer;
  /** The characters it was cut for. */
  codepoints: number[];
}

/** Every cut of one source font this device has kept. */
export async function readCachedSubsets(sourceSha: string): Promise<CachedSubset[]> {
  const db = await openDatabase();
  if (!db) return memorySubsets.get(sourceSha) ?? [];
  return new Promise((resolve) => {
    try {
      const range = IDBKeyRange.bound(`${sourceSha}:`, `${sourceSha}:\uffff`);
      const request = db.transaction(SUBSET_STORE, 'readonly').objectStore(SUBSET_STORE).getAll(range);
      request.onsuccess = () => {
        const rows = Array.isArray(request.result) ? request.result : [];
        resolve(rows.filter((row) => row && row.data instanceof ArrayBuffer && Array.isArray(row.codepoints)));
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    } finally {
      db.close();
    }
  });
}

export async function writeCachedSubset(sourceSha: string, subset: CachedSubset): Promise<void> {
  memorySubsets.set(sourceSha, [...(memorySubsets.get(sourceSha) ?? []), subset]);
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(SUBSET_STORE, 'readwrite');
      transaction.objectStore(SUBSET_STORE).put(subset, `${sourceSha}:${subset.subsetSha}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
}

/* ---------------------------------------------------------------- subsets */

/** The FontFace family a source's cuts are registered under. */
export function hostGlyphAlias(source: HostFontSubsetSource | null | undefined): string | null {
  return source ? `Herdr Glyphs ${source.sha256.slice(0, 12)}` : null;
}

/** Hanzi, kana, Hangul, bopomofo, CJK punctuation and full-width forms. */
export function isCjkCodepoint(codepoint: number): boolean {
  return (codepoint >= 0x2e80 && codepoint <= 0x2fdf)
    || (codepoint >= 0x3000 && codepoint <= 0x33ff)
    || (codepoint >= 0x3400 && codepoint <= 0x4dbf)
    || (codepoint >= 0x4e00 && codepoint <= 0x9fff)
    || (codepoint >= 0xac00 && codepoint <= 0xd7af)
    || (codepoint >= 0xf900 && codepoint <= 0xfaff)
    || (codepoint >= 0xfe30 && codepoint <= 0xfe4f)
    || (codepoint >= 0xff00 && codepoint <= 0xffef)
    || (codepoint >= 0x20000 && codepoint <= 0x3134f);
}

/**
 * Whether a character should come from a cut of this source. Box drawing and
 * block elements never do: the renderer draws those itself, cell-exact.
 */
export function wantsGlyph(scope: HostFontSubsetSource['scope'], codepoint: number): boolean {
  if (codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0)) return false;
  if (codepoint >= 0x2500 && codepoint <= 0x259f) return false;
  return scope === 'all' || isCjkCodepoint(codepoint);
}

/** `U+4E00-4E02, U+4E08` for a list of code points. */
export function toUnicodeRange(codepoints: number[]): string {
  const sorted = [...new Set(codepoints)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[i + 1];
      i += 1;
    }
    const hex = (value: number) => value.toString(16).toUpperCase();
    parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  }
  return parts.join(', ');
}

/**
 * Registers one cut under the source's alias, limited to the characters it
 * was cut for, so each cut answers only for its own characters.
 */
export async function registerGlyphSubset(alias: string, subset: CachedSubset): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('font_api_unavailable');
  }
  const face = new FontFace(alias, subset.data, {
    weight: '400',
    style: 'normal',
    unicodeRange: toUnicodeRange(subset.codepoints),
  });
  document.fonts.add(await face.load());
}

/* ----------------------------------------------------------- registration */

/** Aliases already added to `document.fonts` during this page's life. */
const registeredAliases = new Set<string>();

export function isHostFontRegistered(alias: string | null): boolean {
  return Boolean(alias && registeredAliases.has(alias));
}

/**
 * Registers the fetched faces under one alias family. Resolves once the
 * browser has parsed them: a file it refuses (not a font, or damaged) rejects.
 */
export async function registerHostFontFaces(
  alias: string,
  faces: Array<{ face: HostFontFace; data: ArrayBuffer }>,
): Promise<void> {
  if (registeredAliases.has(alias)) return;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('font_api_unavailable');
  }
  const loaded = await Promise.all(faces.map(({ face, data }) => (
    new FontFace(alias, data, FACE_DESCRIPTORS[face.style]).load()
  )));
  for (const face of loaded) document.fonts.add(face);
  registeredAliases.add(alias);
}

/* --------------------------------------------------------------- transfer */

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Fetches one face a slice at a time, a couple of slices ahead, so the
 * terminal's own output is never stuck behind megabytes of font.
 */
export async function downloadHostFontFace(
  face: HostFontFace,
  requestChunk: (sha256: string, index: number) => Promise<Uint8Array>,
  onBytes: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const total = Math.ceil(face.bytes / HOST_FONT_CHUNK_BYTES);
  const output = new Uint8Array(face.bytes);
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const index = next;
      next += 1;
      const chunk = await requestChunk(face.sha256, index);
      const offset = index * HOST_FONT_CHUNK_BYTES;
      const expected = Math.min(HOST_FONT_CHUNK_BYTES, face.bytes - offset);
      if (chunk.length !== expected) throw new Error('host_font_corrupt');
      output.set(chunk, offset);
      onBytes(chunk.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNKS_IN_FLIGHT, total) }, worker));
  return output.buffer;
}

/* ---------------------------------------------------------------- consent */

const CONSENT_KEY = 'herdr_remote_host_font_consent_v1';
export type HostFontDecision = 'accepted' | 'declined';

function readDecisions(): Record<string, { fingerprint: string; decision: HostFontDecision }> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The user's answer for this workstation and this exact font. A new font on
 * the workstation is a new question.
 */
export function loadHostFontDecision(hostKey: string, fingerprint: string): HostFontDecision | null {
  const entry = readDecisions()[hostKey];
  return entry && entry.fingerprint === fingerprint ? entry.decision : null;
}

export function saveHostFontDecision(hostKey: string, fingerprint: string, decision: HostFontDecision): void {
  try {
    const decisions = readDecisions();
    decisions[hostKey] = { fingerprint, decision };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(decisions));
  } catch {
    // Storage full or blocked: the question may be asked again, nothing worse.
  }
}

export const HOST_FONT_CONSENT_KEY = CONSENT_KEY;
