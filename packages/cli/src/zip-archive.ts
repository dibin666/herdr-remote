// A zip file, built by hand.
//
// Multi-file downloads need one archive, and no dependency the package
// already carries writes zips. The format is small: a local header and the
// bytes per file, then a central directory and an end record. Every file is
// deflated when that shrinks it and stored raw when it does not, which is why
// each entry carries its own method.

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** The path inside the archive, `/`-separated; directories end in `/`. */
  name: string;
  /** Empty for a directory entry. */
  data: Buffer;
  mtimeMs: number;
}

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 11: entry names are UTF-8, which modern unzip reads without a hint. */
const FLAG_UTF8 = 0x0800;
/** The format needs a version no older than this to read what we write. */
const VERSION_NEEDED = 20;

/** The DOS timestamp a zip carries, from an mtime in milliseconds. */
function dosTimeDate(mtimeMs: number): { time: number; date: number } {
  const d = new Date(mtimeMs);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** The whole archive as one buffer, ready to write to a temp file. */
export function buildZipArchive(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('too many files for a zip archive');
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isDir = entry.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : entry.data;
    let method = METHOD_STORE;
    let payload = data;
    if (data.length > 0) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        payload = deflated;
        method = METHOD_DEFLATE;
      }
    }
    const crc = crc32(data) >>> 0;
    const { time, date } = dosTimeDate(entry.mtimeMs);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(VERSION_NEEDED, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    // No extra field, comment or disk number; internal attributes stay zero.
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    // Unix mode in the high word so unzip restores file/dir permissions.
    // Multiplied, not shifted: << yields a signed int32, which overflows here.
    record.writeUInt32LE((isDir ? 0o40755 : 0o100644) * 0x10000, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + payload.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}
