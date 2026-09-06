'use strict';

// Wire protocol shared by the relay and the herdr-remote host connector. This
// module is the single source of truth for both sides: the CLI package imports
// it as `herdr-remote-relay/protocol` rather than keeping its own copy, so the
// framing and the version can never drift apart.

const PROTOCOL_VERSION = 1;
const MAX_HEADER_BYTES = 8 * 1024;

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

function unpackStreamFrame(value) {
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
    type: header.type,
    streamId: header.streamId,
    payload: frame.subarray(4 + headerLength),
  };
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_HEADER_BYTES,
  ANSI_PALETTE_KEYS,
  packStreamFrame,
  unpackStreamFrame,
  sanitizeTerminalPalette,
};
