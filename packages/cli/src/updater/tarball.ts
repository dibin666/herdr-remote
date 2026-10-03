// Unpacking a release tarball without npm.
//
// A release is an `npm pack` tarball: gzip over ustar, every path under
// `package/`, regular files and directories only. Long paths use the ustar
// prefix field or a pax header, both read here. Anything else (links, devices)
// is refused rather than guessed at.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK_BYTES = 512;

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, offset: number, length: number): number {
  const value = field(header, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

/** `path` from a pax extended header: records of `<length> <key>=<value>\n`. */
function paxPath(body: Buffer): string | null {
  let found: string | null = null;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString('utf8'), 10);
    if (!(length > 0)) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') found = record.slice(equals + 1);
    offset += length;
  }
  return found;
}

/**
 * Write the files of a gzipped package tarball under `into`, dropping the
 * leading `package/`. Throws on a malformed archive or a path that would
 * escape `into`.
 */
export function extractPackage(archive: Buffer, into: string): void {
  const tar = zlib.gunzipSync(archive);
  const root = path.resolve(into);
  fs.mkdirSync(root, { recursive: true });
  let nextPath: string | null = null;
  let offset = 0;
  while (offset + BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_BYTES);
    // The archive ends with zero blocks.
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(offset + BLOCK_BYTES, offset + BLOCK_BYTES + size);
    if (body.length < size) throw new Error('truncated release archive');
    offset += BLOCK_BYTES + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;

    if (type === 'x') {
      nextPath = paxPath(body);
      continue;
    }
    if (type === 'L') {
      nextPath = field(body, 0, body.length);
      continue;
    }
    if (type === 'g') continue;

    const prefix = field(header, 345, 155);
    const name =
      nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    nextPath = null;
    const relative = name.replace(/^package\//, '');
    if (relative === name) throw new Error(`unexpected path in release archive: ${name}`);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`))
      throw new Error(`path escapes the release archive: ${name}`);

    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === '0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // npm normalises modes; only whether a file is executable carries over.
      const mode = octal(header, 100, 8) & 0o111 ? 0o755 : 0o644;
      fs.writeFileSync(target, body, { mode });
    } else {
      throw new Error(`unsupported entry type '${type}' in release archive: ${name}`);
    }
  }
}
