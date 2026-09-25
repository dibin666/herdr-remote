// Binary stream frames between the host connector and the relay. Node-only
// (Buffer); browsers receive raw terminal bytes and never parse these.

export const PROTOCOL_VERSION = 1;
export const MAX_HEADER_BYTES = 8 * 1024;

// Framing constants for compact binary frame protocol v2.
// With permessage-deflate already enabled on the WebSocket connection, the repeated
// JSON routing header in v1 frames was already compressed down to near-zero network overhead.
// The actual motivation for v2 framing is reducing CPU consumption: eliminating the per-frame
// JSON.stringify / JSON.parse serialization and string decoding overhead under heavy terminal output.
export const FRAME_V2_MAGIC = 0xff;
export const FRAME_TYPE_OUTPUT = 0;
export const FRAME_TYPE_INPUT = 1;

export type FrameTypeCode = typeof FRAME_TYPE_OUTPUT | typeof FRAME_TYPE_INPUT;
export type FrameBytes = Buffer | Uint8Array | ArrayBuffer | readonly number[] | string;

/** A v1 frame routes by a JSON header naming the stream. */
export interface StreamFrameV1 {
  version: 1;
  type: string;
  streamId: string;
  payload: Buffer;
}

/** A v2 frame routes by a 16-bit stream index. */
export interface StreamFrameV2 {
  version: 2;
  type: 'output' | 'input';
  typeCode: FrameTypeCode;
  streamIndex: number;
  payload: Buffer;
}

export type StreamFrame = StreamFrameV1 | StreamFrameV2;

function toBuffer(value: FrameBytes): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

export function packStreamFrame(
  type: string,
  streamId: string,
  payload: FrameBytes = Buffer.alloc(0),
): Buffer {
  if (typeof type !== 'string' || !type || typeof streamId !== 'string' || !streamId) {
    throw new TypeError('type and streamId must be non-empty strings');
  }
  const body = toBuffer(payload);
  const header = Buffer.from(JSON.stringify({ type, streamId }), 'utf8');
  if (header.length > MAX_HEADER_BYTES) throw new RangeError('stream frame header is too large');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, body]);
}

function unpackStreamFrameV1(value: FrameBytes): StreamFrameV1 {
  const frame = toBuffer(value);
  if (frame.length < 4) throw new Error('stream frame is truncated');
  const headerLength = frame.readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || frame.length < 4 + headerLength) {
    throw new Error('stream frame header is invalid');
  }
  let header: { type?: unknown; streamId?: unknown } | null;
  try {
    header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  } catch (error) {
    throw new Error(`stream frame header is not JSON: ${(error as Error).message}`);
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

export function packStreamFrameV2(
  type: 'output' | 'input' | FrameTypeCode,
  streamIndex: number,
  payload: FrameBytes = Buffer.alloc(0),
): Buffer {
  let typeCode: unknown = type;
  if (type === 'output') typeCode = FRAME_TYPE_OUTPUT;
  else if (type === 'input') typeCode = FRAME_TYPE_INPUT;
  if (typeCode !== FRAME_TYPE_OUTPUT && typeCode !== FRAME_TYPE_INPUT) {
    throw new TypeError('type must be FRAME_TYPE_OUTPUT (0) or FRAME_TYPE_INPUT (1)');
  }
  if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 0xffff) {
    throw new RangeError('streamIndex must be an unsigned 16-bit integer (0-65535)');
  }
  const body = toBuffer(payload);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt8(FRAME_V2_MAGIC, 0);
  frame.writeUInt8(typeCode, 1);
  frame.writeUInt16BE(streamIndex, 2);
  body.copy(frame, 4);
  return frame;
}

export function unpackStreamFrameV2(buffer: FrameBytes): StreamFrameV2 {
  const frame = toBuffer(buffer);
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

export function unpackStreamFrame(value: FrameBytes): StreamFrame {
  const frame = toBuffer(value);
  if (frame.length < 4) throw new Error('stream frame is truncated');
  // v1's headerLength is a 32-bit big-endian integer bounded by MAX_HEADER_BYTES (8KB),
  // so its first byte is always 0x00. A first byte of 0xFF unambiguously identifies v2 framing.
  if (frame[0] === FRAME_V2_MAGIC) {
    return unpackStreamFrameV2(frame);
  }
  return unpackStreamFrameV1(frame);
}
