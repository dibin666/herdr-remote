// Pasted images and files moving from a window to its workstation. The
// one-shot `paste_file` carries a small payload whole; `paste_file_begin`
// plus `paste_file_chunk` stream a file of any size, which the workstation
// pulls a slice at a time — so no single message ever carries the bytes, and
// a slow window cannot queue ahead of terminal output.

import {
  type ClientPasteFileBeginMessage,
  type ClientPasteFileChunkMessage,
  type ClientPasteFileMessage,
  type HostPasteFileChunkRequestMessage,
  PASTE_CHUNK_BYTES,
  PASTE_FILE_MIME,
  PASTE_MAX_BYTES,
  PASTE_REQUEST_ID,
  hasImageSignature,
  isPasteImageMime,
  sanitizePasteFileName,
} from '../protocol/index.js';
import { isOpen, jsonSend } from './sockets.js';
import type { RelayClient, RelayHost } from './types.js';

/** Base64 of one full slice, the most a `paste_file_chunk` may carry. */
const MAX_PASTE_CHUNK_BASE64 = Math.ceil(PASTE_CHUNK_BYTES / 3) * 4;

/** Chunked uploads one window may hold open at once. */
const MAX_PASTE_UPLOADS_PER_CLIENT = 4;

function rejectPaste(client: RelayClient, code: string, text: string, requestId?: unknown): void {
  jsonSend(client.ws, {
    type: 'error',
    code,
    message: text,
    ...(typeof requestId === 'string' ? { requestId } : {}),
  });
}

function verifyImageMagicBytes(mime: string, dataBase64: unknown): boolean {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return false;
  let headerBuf: Buffer;
  try {
    headerBuf = Buffer.from(dataBase64.slice(0, 32), 'base64');
  } catch {
    return false;
  }
  if (headerBuf.length === 0) return false;
  return hasImageSignature(mime, headerBuf);
}

/** The one-shot paste: the whole payload rides a single message. */
export function requestPasteFile(
  host: RelayHost,
  client: RelayClient,
  message: ClientPasteFileMessage,
): void {
  const reject = (code: string, text: string) => rejectPaste(client, code, text);
  if (client.role === 'viewer') {
    reject('viewer_mode', 'Viewer mode cannot paste to terminal');
    return;
  }
  const isFile = message.mime === PASTE_FILE_MIME;
  if (!isFile && !isPasteImageMime(message.mime)) {
    reject('paste_file_unsupported', 'Unsupported paste image format');
    return;
  }
  if (typeof message.dataBase64 !== 'string') {
    reject('paste_file_unsupported', 'Invalid paste payload');
    return;
  }
  const rawLength = Buffer.byteLength(message.dataBase64, 'base64');
  if (rawLength === 0) {
    reject('paste_file_empty', 'Pasted payload is empty');
    return;
  }
  if (rawLength > PASTE_MAX_BYTES) {
    reject('paste_file_too_large', 'Pasted payload exceeds 3 MB limit');
    return;
  }
  if (!isFile && !verifyImageMagicBytes(message.mime, message.dataBase64)) {
    reject('paste_file_unsupported', 'Pasted image content does not match declared MIME type');
    return;
  }
  if (!isOpen(host?.ws)) {
    reject('host_offline', 'Host is offline or disconnected');
    return;
  }
  // A host from before any-file pastes would refuse the type after the
  // whole payload had crossed; saying so here is quicker and clearer.
  if (isFile && !host.pasteAnyFile) {
    reject('paste_file_host_outdated', 'Host is too old to receive files; update herdr-remote');
    return;
  }
  if (!client.session) {
    reject('no_session', 'Terminal session is not ready');
    return;
  }
  jsonSend(host.ws, {
    type: 'paste_file',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    mime: message.mime,
    dataBase64: message.dataBase64,
    ...(isFile ? { name: sanitizePasteFileName(message.name) } : {}),
  });
}

/**
 * `paste_file_begin`: a window announces an upload. No bytes cross yet — the
 * relay registers it so the workstation's pulls can be routed and answered.
 */
export function requestPasteFileBegin(
  host: RelayHost,
  client: RelayClient,
  message: ClientPasteFileBeginMessage,
): void {
  const reject = (code: string, text: string) => rejectPaste(client, code, text, message.requestId);
  if (client.role === 'viewer') {
    reject('viewer_mode', 'Viewer mode cannot paste to terminal');
    return;
  }
  if (typeof message.requestId !== 'string' || !PASTE_REQUEST_ID.test(message.requestId)) return;
  const isFile = message.mime === PASTE_FILE_MIME;
  if (!isFile && !isPasteImageMime(message.mime)) {
    reject('paste_file_unsupported', 'Unsupported paste image format');
    return;
  }
  if (!Number.isSafeInteger(message.size) || message.size <= 0) {
    reject('paste_file_empty', 'Pasted payload is empty');
    return;
  }
  if (!isOpen(host.ws)) {
    reject('host_offline', 'Host is offline or disconnected');
    return;
  }
  // An upload's slices only move while the host pulls; one that cannot pull
  // would wait forever — say so instead, before anything is registered.
  if (!host.pasteStream || (isFile && !host.pasteAnyFile)) {
    reject('paste_file_host_outdated', 'Host is too old to receive files; update herdr-remote');
    return;
  }
  if (!client.session) {
    reject('no_session', 'Terminal session is not ready');
    return;
  }
  client.pasteUploads ||= new Map();
  if (
    client.pasteUploads.size >= MAX_PASTE_UPLOADS_PER_CLIENT &&
    !client.pasteUploads.has(message.requestId)
  ) {
    reject('paste_file_busy', 'Another upload is still in progress');
    return;
  }
  const totalChunks = Math.max(1, Math.ceil(message.size / PASTE_CHUNK_BYTES));
  client.pasteUploads.set(message.requestId, {
    totalChunks,
    mime: message.mime,
    requested: new Set(),
  });
  jsonSend(host.ws, {
    type: 'paste_file_begin',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    mime: message.mime,
    size: message.size,
    ...(isFile ? { name: sanitizePasteFileName(message.name) } : {}),
  });
}

/**
 * `paste_file_chunk`: one slice the workstation asked for. The host pulls, so
 * a slice outside the requested set — stale, duplicated, or pushed uninvited —
 * is dropped rather than forwarded.
 */
export function requestPasteFileChunk(
  host: RelayHost,
  client: RelayClient,
  message: ClientPasteFileChunkMessage,
): void {
  const reject = (code: string, text: string) => rejectPaste(client, code, text, message.requestId);
  const upload =
    typeof message.requestId === 'string' ? client.pasteUploads?.get(message.requestId) : undefined;
  if (!upload || !client.session || !isOpen(host.ws)) return;
  if (
    !Number.isInteger(message.index) ||
    message.index < 0 ||
    message.index >= upload.totalChunks
  ) {
    return;
  }
  if (
    typeof message.dataBase64 !== 'string' ||
    message.dataBase64.length > MAX_PASTE_CHUNK_BASE64
  ) {
    client.pasteUploads?.delete(message.requestId);
    reject('paste_file_unsupported', 'Invalid upload slice');
    return;
  }
  if (!upload.requested.delete(message.index)) return;
  if (
    isPasteImageMime(upload.mime) &&
    message.index === 0 &&
    !verifyImageMagicBytes(upload.mime, message.dataBase64)
  ) {
    client.pasteUploads?.delete(message.requestId);
    reject('paste_file_unsupported', 'Pasted image content does not match declared MIME type');
    return;
  }
  jsonSend(host.ws, {
    type: 'paste_file_chunk',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    index: message.index,
    dataBase64: message.dataBase64,
  });
}

/** The workstation asks for one slice of an upload this window announced. */
export function forwardPasteFileChunkRequest(
  client: RelayClient,
  message: HostPasteFileChunkRequestMessage,
): void {
  const upload =
    typeof message.requestId === 'string' ? client.pasteUploads?.get(message.requestId) : undefined;
  if (!upload) return;
  if (
    !Number.isInteger(message.index) ||
    message.index < 0 ||
    message.index >= upload.totalChunks
  ) {
    return;
  }
  upload.requested.add(message.index);
  jsonSend(client.ws, {
    type: 'paste_file_chunk_request',
    requestId: message.requestId,
    index: message.index,
  });
}

/** A finished or failed upload stops being pullable. */
export function settlePasteUpload(client: RelayClient, requestId: unknown): void {
  if (typeof requestId === 'string') client.pasteUploads?.delete(requestId);
}
