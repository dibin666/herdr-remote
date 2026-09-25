// Terminal font files and cuts, passed between a window and its workstation a
// slice at a time, and only for what the workstation announced.

import {
  type ClientHostFontChunkRequestMessage,
  type ClientHostFontSubsetRequestMessage,
  type HostFontChunkMessage,
  type HostFontSubsetMessage,
  TERMINAL_FONT_CHUNK_BYTES,
} from '../protocol/index.js';
import { isOpen, jsonSend } from './sockets.js';
import type { RelayClient, RelayHost } from './types.js';

/**
 * Font chunks a window may have outstanding. Fonts are pulled a slice at a
 * time so megabytes of font never queue ahead of terminal output; an answer
 * that never comes stops counting after the timeout.
 */
const MAX_FONT_CHUNKS_IN_FLIGHT = 4;

const FONT_CHUNK_TIMEOUT_MS = 30_000;

/** Base64 of one full chunk, the most a `host_font_chunk` may carry. */
const MAX_FONT_CHUNK_BASE64 = Math.ceil(TERMINAL_FONT_CHUNK_BYTES / 3) * 4;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Characters one subset request may ask for (UTF-16 units of `text`). */
const MAX_FONT_SUBSET_TEXT = 32 * 1024;

/** Cut fonts a window may pull by hash; older ones stop being fetchable. */
const MAX_FONT_SUBSETS_PER_CLIENT = 64;

const MAX_FONT_SUBSET_BYTES = 16 * 1024 * 1024;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** One outstanding font chunk request of this window was answered. */
export function settleFontChunk(client: RelayClient): void {
  if (Array.isArray(client.fontChunkRequests) && client.fontChunkRequests.length)
    client.fontChunkRequests.shift();
}

/** One outstanding font subset request of this window was answered. */
export function settleFontSubset(client: RelayClient): void {
  if (Array.isArray(client.fontSubsetRequests) && client.fontSubsetRequests.length)
    client.fontSubsetRequests.shift();
}

/**
 * Pass a browser's request for one slice of a font file to its workstation.
 * Only a file the workstation announced can be asked for, by its hash, and
 * only a few slices at a time.
 */
export function requestFontChunk(
  host: RelayHost,
  client: RelayClient,
  message: ClientHostFontChunkRequestMessage,
): void {
  if (!client.session || !isOpen(host.ws)) return;
  const face = host.terminalFont?.faces?.find((candidate) => candidate.sha256 === message.sha256);
  // A whole font file the workstation announced, or a cut it made for this window.
  const bytes = face ? face.bytes : client.fontSubsets?.get(message.sha256) || 0;
  const total = Math.ceil(bytes / TERMINAL_FONT_CHUNK_BYTES);
  if (!bytes || !Number.isInteger(message.index) || message.index < 0 || message.index >= total) {
    jsonSend(client.ws, {
      type: 'error',
      code: 'host_font_unavailable',
      message: 'The workstation did not offer this font file',
    });
    return;
  }
  const now = Date.now();
  client.fontChunkRequests = (client.fontChunkRequests || []).filter(
    (at) => now - at < FONT_CHUNK_TIMEOUT_MS,
  );
  if (client.fontChunkRequests.length >= MAX_FONT_CHUNKS_IN_FLIGHT) return;
  client.fontChunkRequests.push(now);
  jsonSend(host.ws, {
    type: 'host_font_chunk_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    sha256: message.sha256,
    index: message.index,
  });
}

/**
 * Ask the workstation to cut characters out of a large font it announced.
 * The text is only characters to look up; a few requests at a time.
 */
export function requestFontSubset(
  host: RelayHost,
  client: RelayClient,
  message: ClientHostFontSubsetRequestMessage,
): void {
  if (!client.session || !isOpen(host.ws)) return;
  const known = host.terminalFont?.subsets?.some((source) => source.sha256 === message.sha256);
  const valid =
    known &&
    typeof message.text === 'string' &&
    message.text.length > 0 &&
    message.text.length <= MAX_FONT_SUBSET_TEXT &&
    typeof message.requestId === 'string' &&
    REQUEST_ID.test(message.requestId);
  if (!valid) {
    jsonSend(client.ws, {
      type: 'error',
      code: 'host_font_unavailable',
      message: 'The workstation did not offer this font',
    });
    return;
  }
  const now = Date.now();
  client.fontSubsetRequests = (client.fontSubsetRequests || []).filter(
    (at) => now - at < FONT_CHUNK_TIMEOUT_MS,
  );
  if (client.fontSubsetRequests.length >= MAX_FONT_CHUNKS_IN_FLIGHT) return;
  client.fontSubsetRequests.push(now);
  jsonSend(host.ws, {
    type: 'host_font_subset_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    sha256: message.sha256,
    text: message.text,
  });
}

export function forwardFontSubset(client: RelayClient, message: HostFontSubsetMessage): void {
  settleFontSubset(client);
  const valid =
    typeof message.sha256 === 'string' &&
    SHA256_HEX.test(message.sha256) &&
    typeof message.subsetSha === 'string' &&
    SHA256_HEX.test(message.subsetSha) &&
    typeof message.requestId === 'string' &&
    REQUEST_ID.test(message.requestId) &&
    Number.isInteger(message.bytes) &&
    message.bytes > 0 &&
    message.bytes <= MAX_FONT_SUBSET_BYTES &&
    (message.dataBase64 === undefined ||
      (typeof message.dataBase64 === 'string' &&
        message.dataBase64.length <= MAX_FONT_CHUNK_BASE64));
  if (!valid) return;
  if (message.dataBase64 === undefined) {
    // Pulled in slices next: make this hash fetchable for this window only.
    client.fontSubsets ||= new Map();
    client.fontSubsets.delete(message.subsetSha);
    client.fontSubsets.set(message.subsetSha, message.bytes);
    while (client.fontSubsets.size > MAX_FONT_SUBSETS_PER_CLIENT) {
      const oldest = client.fontSubsets.keys().next().value;
      if (oldest !== undefined) client.fontSubsets.delete(oldest);
    }
  }
  jsonSend(client.ws, {
    type: 'host_font_subset_ready',
    requestId: message.requestId,
    sha256: message.sha256,
    subsetSha: message.subsetSha,
    bytes: message.bytes,
    ...(message.dataBase64 !== undefined ? { dataBase64: message.dataBase64 } : {}),
  });
}

export function forwardFontChunk(client: RelayClient, message: HostFontChunkMessage): void {
  settleFontChunk(client);
  const valid =
    typeof message.sha256 === 'string' &&
    SHA256_HEX.test(message.sha256) &&
    Number.isInteger(message.index) &&
    message.index >= 0 &&
    Number.isInteger(message.total) &&
    message.total > message.index &&
    typeof message.dataBase64 === 'string' &&
    message.dataBase64.length <= MAX_FONT_CHUNK_BASE64;
  if (!valid) return;
  jsonSend(client.ws, {
    type: 'host_font_chunk',
    sha256: message.sha256,
    index: message.index,
    total: message.total,
    dataBase64: message.dataBase64,
  });
}
