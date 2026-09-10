'use strict';

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

module.exports = {
  PROTOCOL_VERSION,
  MAX_HEADER_BYTES,
  FRAME_V2_MAGIC,
  FRAME_TYPE_OUTPUT,
  FRAME_TYPE_INPUT,
  ANSI_PALETTE_KEYS,
  packStreamFrame,
  unpackStreamFrame,
  packStreamFrameV2,
  unpackStreamFrameV2,
  sanitizeTerminalPalette,
};
