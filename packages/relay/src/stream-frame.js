// Wire protocol shared by the relay and the herdr-remote host connector. This
// module is the single source of truth for both sides: the CLI package imports
// it as `herdr-remote-relay/protocol` rather than keeping its own copy, so the
// framing and the version can never drift apart.

const PROTOCOL_VERSION = 1;
const MAX_HEADER_BYTES = 8 * 1024;

// Framing constants for compact binary frame protocol v2.
// With permessage-deflate already enabled on the WebSocket connection, the repeated
// JSON routing header in v1 frames was already compressed down to near-zero network overhead.
// The actual motivation for v2 framing is reducing CPU consumption: eliminating the per-frame
// JSON.stringify / JSON.parse serialization and string decoding overhead under heavy terminal output.
const FRAME_V2_MAGIC = 0xff;
const FRAME_TYPE_OUTPUT = 0;
const FRAME_TYPE_INPUT = 1;

/**
 * The sixteen ANSI slots a host may report, in index order. A palette is
 * all-or-nothing: half the host's colors mixed with half the browser's would
 * look worse than either set on its own.
 */
const ANSI_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Validates a terminal palette crossing the wire.
 *
 * The host reports what its own terminal answered to the OSC color queries,
 * and the browser paints with it. Anything that is not a plain `#rrggbb`
 * string is dropped here, so a compromised or buggy host cannot push arbitrary
 * data into a browser's renderer options.
 */
function sanitizeTerminalPalette(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const palette = {};
  for (const key of ['background', 'foreground', 'cursor']) {
    const color = value[key];
    if (typeof color === 'string' && HEX_COLOR.test(color)) palette[key] = color.toLowerCase();
  }
  const ansi = value.ansi;
  if (ansi && typeof ansi === 'object' && !Array.isArray(ansi)) {
    const collected = {};
    for (const key of ANSI_PALETTE_KEYS) {
      const color = ansi[key];
      if (typeof color === 'string' && HEX_COLOR.test(color)) collected[key] = color.toLowerCase();
    }
    if (Object.keys(collected).length === ANSI_PALETTE_KEYS.length) palette.ansi = collected;
  }
  return Object.keys(palette).length > 0 ? palette : null;
}

/** The faces a host may offer, in the order a browser registers them. */
const TERMINAL_FONT_STYLES = ['regular', 'bold', 'italic', 'boldItalic'];
const TERMINAL_FONT_FORMATS = ['truetype', 'opentype'];
/** `cjk`: the face Hanzi fall back to; `all`: the family itself, too big to send whole. */
const TERMINAL_FONT_SUBSET_SCOPES = ['cjk', 'all'];
/** One font file; a CJK face is larger than this and is left to the browser. */
const MAX_TERMINAL_FONT_BYTES = 16 * 1024 * 1024;
/** Raw bytes per `host_font_chunk`; base64 keeps it far below any payload cap. */
const TERMINAL_FONT_CHUNK_BYTES = 256 * 1024;
/**
 * A family name ends up inside a CSS `font-family` list in the browser. Quotes,
 * separators and escapes are what would let a name break out of its slot, and
 * no real family needs them.
 */
const FONT_FAMILY_FORBIDDEN = /["'\\;,{}<>@\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validates the terminal font a host reports.
 *
 * The browser draws the session in the family the workstation's terminal
 * uses, and may fetch the font files by their hash. Every field is optional
 * except the family; anything malformed is dropped rather than repaired.
 */
function sanitizeTerminalFont(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const family = typeof value.family === 'string' ? value.family.trim() : '';
  if (!family || family.length > 128 || FONT_FAMILY_FORBIDDEN.test(family)) return null;

  const font = { family };
  const size = Number(value.sizePx);
  if (Number.isFinite(size) && size >= 4 && size <= 96) font.sizePx = Math.round(size * 10) / 10;
  if (typeof value.source === 'string' && /^[a-z0-9-]{1,32}$/.test(value.source))
    font.source = value.source;

  const faces = [];
  const seen = new Set();
  for (const face of Array.isArray(value.faces) ? value.faces.slice(0, 16) : []) {
    if (!face || typeof face !== 'object') continue;
    if (!TERMINAL_FONT_STYLES.includes(face.style) || seen.has(face.style)) continue;
    if (!TERMINAL_FONT_FORMATS.includes(face.format)) continue;
    if (!Number.isInteger(face.bytes) || face.bytes <= 0 || face.bytes > MAX_TERMINAL_FONT_BYTES)
      continue;
    if (typeof face.sha256 !== 'string' || !SHA256_HEX.test(face.sha256)) continue;
    seen.add(face.style);
    faces.push({ style: face.style, format: face.format, bytes: face.bytes, sha256: face.sha256 });
  }
  font.faces = faces;

  // Large fonts (CJK above all) are offered a few characters at a time.
  const subsets = [];
  for (const source of Array.isArray(value.subsets) ? value.subsets.slice(0, 16) : []) {
    if (!source || typeof source !== 'object') continue;
    const name = typeof source.family === 'string' ? source.family.trim() : '';
    if (!name || name.length > 128 || FONT_FAMILY_FORBIDDEN.test(name)) continue;
    if (source.style !== 'regular' || !TERMINAL_FONT_SUBSET_SCOPES.includes(source.scope)) continue;
    if (typeof source.sha256 !== 'string' || !SHA256_HEX.test(source.sha256)) continue;
    if (subsets.some((known) => known.scope === source.scope)) continue;
    subsets.push({ family: name, style: 'regular', scope: source.scope, sha256: source.sha256 });
  }
  font.subsets = subsets;
  return font;
}

function packStreamFrame(type, streamId, payload = Buffer.alloc(0)) {
  if (typeof type !== 'string' || !type || typeof streamId !== 'string' || !streamId) {
    throw new TypeError('type and streamId must be non-empty strings');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.from(JSON.stringify({ type, streamId }), 'utf8');
  if (header.length > MAX_HEADER_BYTES) throw new RangeError('stream frame header is too large');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, body]);
}

function unpackStreamFrameV1(value) {
  const frame = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (frame.length < 4) throw new Error('stream frame is truncated');
  const headerLength = frame.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || frame.length < 4 + headerLength) {
    throw new Error('stream frame header is invalid');
  }
  let header;
  try {
    header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  } catch (error) {
    throw new Error(`stream frame header is not JSON: ${error.message}`);
  }
  if (!header || typeof header.type !== 'string' || typeof header.streamId !== 'string') {
    throw new Error('stream frame header is missing routing fields');
  }
  return {
    version: 1,
    type: header.type,
    streamId: header.streamId,
    payload: frame.subarray(4 + headerLength),
  };
}

function packStreamFrameV2(type, streamIndex, payload = Buffer.alloc(0)) {
  let typeCode = type;
  if (type === 'output') typeCode = FRAME_TYPE_OUTPUT;
  else if (type === 'input') typeCode = FRAME_TYPE_INPUT;
  if (typeCode !== FRAME_TYPE_OUTPUT && typeCode !== FRAME_TYPE_INPUT) {
    throw new TypeError('type must be FRAME_TYPE_OUTPUT (0) or FRAME_TYPE_INPUT (1)');
  }
  if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 0xffff) {
    throw new RangeError('streamIndex must be an unsigned 16-bit integer (0-65535)');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt8(FRAME_V2_MAGIC, 0);
  frame.writeUInt8(typeCode, 1);
  frame.writeUInt16BE(streamIndex, 2);
  body.copy(frame, 4);
  return frame;
}

function unpackStreamFrameV2(buffer) {
  const frame = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (frame.length < 4) throw new Error('v2 stream frame is truncated');
  const magic = frame.readUInt8(0);
  if (magic !== FRAME_V2_MAGIC) {
    throw new Error('invalid v2 stream frame magic byte');
  }
  const typeCode = frame.readUInt8(1);
  if (typeCode !== FRAME_TYPE_OUTPUT && typeCode !== FRAME_TYPE_INPUT) {
    throw new Error(`unknown v2 stream frame type: ${typeCode}`);
  }
  const streamIndex = frame.readUInt16BE(2);
  return {
    version: 2,
    type: typeCode === FRAME_TYPE_OUTPUT ? 'output' : 'input',
    typeCode,
    streamIndex,
    payload: frame.subarray(4),
  };
}

function unpackStreamFrame(value) {
  const frame = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (frame.length < 4) throw new Error('stream frame is truncated');
  // v1's headerLength is a 32-bit big-endian integer bounded by MAX_HEADER_BYTES (8KB),
  // so its first byte is always 0x00. A first byte of 0xFF unambiguously identifies v2 framing.
  if (frame[0] === FRAME_V2_MAGIC) {
    return unpackStreamFrameV2(frame);
  }
  return unpackStreamFrameV1(frame);
}

export {
  PROTOCOL_VERSION,
  MAX_HEADER_BYTES,
  FRAME_V2_MAGIC,
  FRAME_TYPE_OUTPUT,
  FRAME_TYPE_INPUT,
  ANSI_PALETTE_KEYS,
  TERMINAL_FONT_STYLES,
  MAX_TERMINAL_FONT_BYTES,
  TERMINAL_FONT_CHUNK_BYTES,
  packStreamFrame,
  unpackStreamFrame,
  packStreamFrameV2,
  unpackStreamFrameV2,
  sanitizeTerminalPalette,
  sanitizeTerminalFont,
};
