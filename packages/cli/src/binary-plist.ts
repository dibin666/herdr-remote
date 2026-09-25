/**
 * Reads Apple binary property lists (`bplist00`), the format macOS writes its
 * preference files in, and the NSKeyedArchiver graphs stored inside them.
 *
 * Terminal.app keeps each profile's font as an archived NSFont — a binary
 * plist nested in a binary plist — and there is no command-line tool that
 * turns that into something readable without asking Terminal itself (an
 * AppleScript that prompts for Automation access). A reader this small is
 * less intrusive than any of those.
 */

/** A reference to another object in a keyed archive (`CF$UID`). */
class Uid {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** What a property list decodes to. */
export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Buffer
  | Date
  | Uid
  | PlistValue[]
  | { [key: string]: PlistValue };

/** A keyed archive with its references resolved; a dangling one reads as undefined. */
export type UnarchivedValue =
  | Exclude<PlistValue, PlistValue[] | { [key: string]: PlistValue }>
  | undefined
  | UnarchivedValue[]
  | { [key: string]: UnarchivedValue };

function readSizedInt(buffer: Buffer, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
  return value;
}

/**
 * Parses a whole `bplist00` buffer into plain values: objects, arrays,
 * strings, numbers, booleans, Buffers (data), Dates and `Uid`s. Throws on
 * anything malformed; callers treat that as "no answer".
 */
function parseBinaryPlist(buffer: unknown): PlistValue {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 40 ||
    buffer.toString('latin1', 0, 8) !== 'bplist00'
  ) {
    throw new Error('not a binary plist');
  }
  const trailer = buffer.length - 32;
  const offsetSize = buffer[trailer + 6];
  const refSize = buffer[trailer + 7];
  const count = readSizedInt(buffer, trailer + 8, 8);
  const top = readSizedInt(buffer, trailer + 16, 8);
  const tableOffset = readSizedInt(buffer, trailer + 24, 8);
  if (!offsetSize || !refSize || count > 1_000_000 || tableOffset + count * offsetSize > trailer) {
    throw new Error('corrupt binary plist trailer');
  }
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1)
    offsets.push(readSizedInt(buffer, tableOffset + i * offsetSize, offsetSize));

  const parsing = new Set<number>();
  const parse = (index: number): PlistValue => {
    if (index >= count || parsing.has(index)) throw new Error('corrupt binary plist reference');
    parsing.add(index);
    try {
      return parseObject(offsets[index]);
    } finally {
      parsing.delete(index);
    }
  };

  // A length stored in the marker's low nibble, or as the int object after it.
  const lengthAt = (offset: number): { length: number; start: number } => {
    const low = buffer[offset] & 0x0f;
    if (low !== 0x0f) return { length: low, start: offset + 1 };
    const marker = buffer[offset + 1];
    if ((marker & 0xf0) !== 0x10) throw new Error('corrupt binary plist length');
    const size = 1 << (marker & 0x0f);
    return { length: readSizedInt(buffer, offset + 2, size), start: offset + 2 + size };
  };

  const parseObject = (offset: number): PlistValue => {
    const marker = buffer[offset];
    const type = marker >> 4;
    const low = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1: {
        const size = 1 << low;
        if (size === 8) return Number(buffer.readBigInt64BE(offset + 1));
        return readSizedInt(buffer, offset + 1, size);
      }
      case 0x2:
        return low === 2 ? buffer.readFloatBE(offset + 1) : buffer.readDoubleBE(offset + 1);
      case 0x3:
        return new Date(Date.UTC(2001, 0, 1) + buffer.readDoubleBE(offset + 1) * 1000);
      case 0x4: {
        const { length, start } = lengthAt(offset);
        return buffer.subarray(start, start + length);
      }
      case 0x5: {
        const { length, start } = lengthAt(offset);
        return buffer.toString('latin1', start, start + length);
      }
      case 0x6: {
        const { length, start } = lengthAt(offset);
        return Buffer.from(buffer.subarray(start, start + length * 2))
          .swap16()
          .toString('utf16le');
      }
      case 0x8:
        return new Uid(readSizedInt(buffer, offset + 1, low + 1));
      case 0xa:
      case 0xc: {
        const { length, start } = lengthAt(offset);
        const items: PlistValue[] = [];
        for (let i = 0; i < length; i += 1)
          items.push(parse(readSizedInt(buffer, start + i * refSize, refSize)));
        return items;
      }
      case 0xd: {
        const { length, start } = lengthAt(offset);
        const result: { [key: string]: PlistValue } = {};
        for (let i = 0; i < length; i += 1) {
          const key = parse(readSizedInt(buffer, start + i * refSize, refSize));
          result[String(key)] = parse(
            readSizedInt(buffer, start + (length + i) * refSize, refSize),
          );
        }
        return result;
      }
      default:
        throw new Error(`unsupported binary plist object 0x${marker.toString(16)}`);
    }
  };

  return parse(top);
}

/**
 * The root object of an NSKeyedArchiver plist, with every `Uid` replaced by
 * the object it points at (to a bounded depth; archives may be cyclic).
 */
function unarchiveKeyed(archive: PlistValue, depth = 6): UnarchivedValue {
  const record = (value: PlistValue | undefined) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { [key: string]: PlistValue })
      : undefined;
  const objects = record(archive)?.$objects;
  const rootRef = record(record(archive)?.$top)?.root;
  if (!Array.isArray(objects) || !(rootRef instanceof Uid)) throw new Error('not a keyed archive');
  const resolve = (value: PlistValue | undefined, level: number): UnarchivedValue => {
    if (value instanceof Uid)
      return level > depth ? null : resolve(objects[value.value], level + 1);
    if (Array.isArray(value)) return value.map((item) => resolve(item, level));
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      const result: { [key: string]: UnarchivedValue } = {};
      for (const [key, item] of Object.entries(value)) result[key] = resolve(item, level);
      return result;
    }
    return value === '$null' ? null : value;
  };
  return resolve(rootRef, 0);
}

export { Uid, parseBinaryPlist, unarchiveKeyed };
