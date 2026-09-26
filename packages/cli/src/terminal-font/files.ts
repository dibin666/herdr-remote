// The files behind a font family: found with fontconfig (or, on a stock
// macOS, by reading the fonts' own name tables) and described by hash.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type HostFontFace,
  type HostFontFormat,
  type HostFontStyle,
  type HostFontSubsetScope,
  type HostFontSubsetSource,
  MAX_TERMINAL_FONT_BYTES,
  TERMINAL_FONT_STYLES,
} from 'herdr-remote-relay/protocol';
import { type Deps, type FontDeps, GENERIC_FAMILIES, withDefaults } from './deps.js';

/** A face as announced, plus where it is on this machine. */
export type LocalFontFace = HostFontFace & { path: string; mtimeMs: number };

/** A subset source as announced, plus where it is on this machine. */
export type LocalSubsetSource = HostFontSubsetSource & {
  path: string;
  index: number;
  bytes: number;
  mtimeMs: number;
};

interface LocatedFont {
  file: string;
  families: string[];
  index: number;
}

const FACE_PATTERNS: Record<HostFontStyle, string> = {
  regular: ':weight=regular:slant=roman',
  bold: ':weight=bold:slant=roman',
  italic: ':weight=regular:slant=italic',
  boldItalic: ':weight=bold:slant=italic',
};

function escapeFontconfig(value: string): string {
  return value.replace(/([\\\-:,])/g, '\\$1');
}

/** `00 01 00 00` / `true` are TrueType, `OTTO` is CFF OpenType. */
function sfntFormat(header: Buffer | null | undefined): HostFontFormat | null {
  if (!header || header.length < 4) return null;
  const tag = header.subarray(0, 4).toString('latin1');
  if (tag === '\x00\x01\x00\x00' || tag === 'true') return 'truetype';
  if (tag === 'OTTO') return 'opentype';
  return null;
}

function readHeader(filePath: string, length: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a read-only descriptor cannot lose data.
      }
  }
}

/**
 * The family, subfamily and PostScript names in a TTF/OTF `name` table. Used
 * where fontconfig is absent — a stock macOS — to find a family's files.
 */
function readSfntNames(
  filePath: string,
): { family: string | null; subfamily: string; postscript: string | null } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (!sfntFormat(head)) return null;
    const tables = head.readUInt16BE(4);
    const directory = Buffer.alloc(tables * 16);
    fs.readSync(fd, directory, 0, directory.length, 12);
    let offset = -1;
    let length = 0;
    for (let i = 0; i < tables; i += 1) {
      if (directory.toString('latin1', i * 16, i * 16 + 4) === 'name') {
        offset = directory.readUInt32BE(i * 16 + 8);
        length = directory.readUInt32BE(i * 16 + 12);
      }
    }
    if (offset < 0 || length > 1024 * 1024) return null;
    const table = Buffer.alloc(length);
    fs.readSync(fd, table, 0, length, offset);
    const count = table.readUInt16BE(2);
    const strings = table.readUInt16BE(4);
    const names: Record<number, string> = {};
    for (let i = 0; i < count; i += 1) {
      const record = 6 + i * 12;
      const platformId = table.readUInt16BE(record);
      const languageId = table.readUInt16BE(record + 4);
      const nameId = table.readUInt16BE(record + 6);
      const size = table.readUInt16BE(record + 8);
      const start = strings + table.readUInt16BE(record + 10);
      if (![1, 2, 6, 16, 17].includes(nameId) || start + size > table.length) continue;
      let text: string | undefined;
      if ((platformId === 3 || platformId === 0) && size % 2 === 0) {
        if (platformId === 3 && languageId !== 0x409 && names[nameId]) continue;
        const utf16 = Buffer.from(table.subarray(start, start + size));
        text = utf16.swap16().toString('utf16le');
      } else if (platformId === 1 && !names[nameId]) {
        text = table.toString('latin1', start, start + size);
      }
      if (text) names[nameId] = text;
    }
    return {
      family: names[16] || names[1] || null,
      subfamily: names[17] || names[2] || '',
      postscript: names[6] || null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a read-only descriptor cannot lose data.
      }
  }
}

function macFontFiles(deps: Deps): string[] {
  const roots = [
    path.join(deps.home, 'Library', 'Fonts'),
    '/Library/Fonts',
    '/System/Library/Fonts',
  ];
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (/\.(ttf|otf)$/i.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return files;
}

/** Apple's own terminal faces, which live outside the font folders. */
const APPLE_POSTSCRIPT_FAMILIES: [RegExp, string][] = [
  [/^\.?SF(NS)?Mono/, 'SF Mono'],
  [/^Menlo-/, 'Menlo'],
  [/^Monaco$/, 'Monaco'],
  [/^Courier(New)?/, 'Courier New'],
  [/^AndaleMono$/, 'Andale Mono'],
];

export function familyForPostScriptName(postscript: string, deps: Deps): string | null {
  const apple = APPLE_POSTSCRIPT_FAMILIES.find(([pattern]) => pattern.test(postscript));
  if (apple && deps.platform === 'darwin') return apple[1];
  const listed = deps.run('fc-list', [`:postscriptname=${escapeFontconfig(postscript)}`, 'family']);
  if (listed.status === 0 && listed.stdout.trim())
    return listed.stdout.trim().split('\n')[0].split(',')[0].trim();
  if (deps.platform !== 'darwin') return null;
  for (const file of macFontFiles(deps)) {
    const names = readSfntNames(file);
    if (names?.postscript === postscript) return names.family;
  }
  return null;
}

function styleOfSubfamily(subfamily: unknown): HostFontStyle | null {
  const text = String(subfamily || '').toLowerCase();
  const bold = /\bbold\b/.test(text) && !/(semi|demi|extra|ultra)\s*bold/.test(text);
  const italic = /italic|oblique/.test(text);
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return /^(regular|normal|book|roman)$/.test(text.trim()) ? 'regular' : null;
}

/** Candidate files per style, from fontconfig or, failing that, a scan. */
function locateFaceFiles(family: string, deps: Deps): Partial<Record<HostFontStyle, string>> {
  const located: Partial<Record<HostFontStyle, string>> = {};
  let fontconfig = false;
  for (const style of TERMINAL_FONT_STYLES) {
    const result = deps.run('fc-match', [
      '-f',
      '%{file}\n%{family}\n%{index}\n',
      `${escapeFontconfig(family)}${FACE_PATTERNS[style]}`,
    ]);
    if (result.status !== 0) continue;
    fontconfig = true;
    const [file, families = '', index = '0'] = result.stdout.split('\n');
    // fontconfig always answers; an answer in another family means the
    // requested one is not installed. A collection member is not a file a
    // browser can load on its own.
    const names = families.split(',').map((name) => name.trim().toLowerCase());
    if (!file || !names.includes(family.toLowerCase()) || Number(index) !== 0) continue;
    located[style] = file;
  }
  if (fontconfig || deps.platform !== 'darwin') return located;

  for (const file of macFontFiles(deps)) {
    const names = readSfntNames(file);
    if (!names || names.family?.toLowerCase() !== family.toLowerCase()) continue;
    const style = styleOfSubfamily(names.subfamily);
    if (style && !located[style]) located[style] = file;
  }
  return located;
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * The files behind a family, ready to be offered to a browser.
 *
 * A style fontconfig can only satisfy with the regular file is left out: the
 * browser synthesises bold and italic from the regular face just as well, and
 * sending the same file twice would only cost the phone the bytes.
 */
export function resolveFontFaces(
  family: string | null | undefined,
  deps: FontDeps = {},
): LocalFontFace[] {
  const resolved = withDefaults(deps);
  if (!family || GENERIC_FAMILIES.has(family.toLowerCase())) return [];
  const located = locateFaceFiles(family, resolved);
  const faces: LocalFontFace[] = [];
  const usedFiles = new Set<string>();
  for (const style of TERMINAL_FONT_STYLES) {
    const file = located[style];
    if (!file || usedFiles.has(file)) continue;
    // Apple's system fonts (SF Mono, Menlo…) are licensed for Apple devices
    // only; offering them to any browser would redistribute them. An Apple
    // device has them already, and anything else falls back by name.
    if (/^\/System\//.test(file) || /\.app\/Contents\//.test(file)) continue;
    if (style !== 'regular' && !faces.length) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TERMINAL_FONT_BYTES) continue;
    const format = sfntFormat(readHeader(file, 4));
    if (!format) continue;
    usedFiles.add(file);
    faces.push({
      style,
      format,
      bytes: stat.size,
      sha256: hashFile(file),
      path: file,
      mtimeMs: stat.mtimeMs,
    });
  }
  return faces;
}

/** A file a subset can be cut from; far larger than a face sent whole. */
const MAX_SUBSET_SOURCE_BYTES = 64 * 1024 * 1024;

/** Where fontconfig finds `pattern`: the file, the face's names, its index. */
function locateFont(pattern: string, deps: Deps): LocatedFont | null {
  const result = deps.run('fc-match', ['-f', '%{file}\n%{family}\n%{index}\n', pattern]);
  if (result.status !== 0) return null;
  const [file, families = '', index = '0'] = result.stdout.split('\n');
  if (!file) return null;
  return {
    file,
    families: families
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    index: Number(index) || 0,
  };
}

/**
 * Fonts the browser receives a few characters at a time instead of whole:
 *
 * - `cjk`: the face fontconfig falls back to for Chinese under this family —
 *   what the workstation's terminal actually draws Hanzi with. 16–20 MB, and
 *   often inside a collection (.ttc) a browser cannot load anyway.
 * - `all`: the family itself, when it is too large or in a collection to be
 *   sent as a whole file (a CJK programming font like Sarasa Mono).
 *
 * Only regular weights: the browser emboldens them for bold text, which is
 * how a missing bold is drawn everywhere else too.
 */
export function resolveSubsetSources(
  family: string | null | undefined,
  faces: { style: string }[],
  deps: FontDeps = {},
): LocalSubsetSource[] {
  const resolved = withDefaults(deps);
  if (!family || GENERIC_FAMILIES.has(family.toLowerCase())) return [];
  const wanted = family.toLowerCase();
  const sources: LocalSubsetSource[] = [];
  const add = (located: LocatedFont | null, scope: HostFontSubsetScope, name: string) => {
    if (!located || /^\/System\//.test(located.file) || /\.app\/Contents\//.test(located.file))
      return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(located.file);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_SUBSET_SOURCE_BYTES) return;
    const header = readHeader(located.file, 4);
    if (!sfntFormat(header) && header?.toString('latin1') !== 'ttcf') return;
    // Identifies the face without reading 20 MB: a browser caches by it.
    const sha256 = crypto
      .createHash('sha256')
      .update(`${located.file}\0${located.index}\0${stat.size}\0${stat.mtimeMs}`)
      .digest('hex');
    sources.push({
      family: name,
      style: 'regular',
      scope,
      sha256,
      path: located.file,
      index: located.index,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  };

  const self = locateFont(`${escapeFontconfig(family)}${FACE_PATTERNS.regular}`, resolved);
  const selfInstalled = self && self.families.some((name) => name.toLowerCase() === wanted);
  if (selfInstalled && !faces.some((face) => face.style === 'regular')) add(self, 'all', family);

  const cjk = locateFont(
    `${escapeFontconfig(family)}:charset=4e00${FACE_PATTERNS.regular}`,
    resolved,
  );
  const coveredBySelf = cjk && cjk.families.some((name) => name.toLowerCase() === wanted);
  if (cjk && !coveredBySelf && cjk.families[0]) add(cjk, 'cjk', cjk.families[0]);
  return sources;
}

/** A generic family is replaced by the real face fontconfig picks for it. */
export function concreteFamily(family: string, deps: Deps): string | null {
  if (!GENERIC_FAMILIES.has(String(family).toLowerCase())) return family;
  const result = deps.run('fc-match', ['-f', '%{family[0]}', family]);
  const matched = result.status === 0 ? result.stdout.trim() : '';
  return matched || null;
}
