/**
 * Secure file storage and validation for pasted clipboard images and uploaded files.
 *
 * Security requirements:
 * 1. Pinned directory: writes strictly to path.join(stateDir(), 'pasted') (directory mode 0o700).
 * 2. Unpredictable filename: starts with crypto.randomUUID(); a client-provided name is only
 *    appended to a file's UUID after sanitizePasteFileName, never used as a path.
 * 3. Whitelisted extension: an image's is derived exclusively from its verified MIME type.
 * 4. Host-side size check: the one-shot `paste_file` is re-validated to <= 3 MB; chunked
 *    uploads have no size ceiling — their slices are written to disk as they arrive.
 * 5. Magic bytes sniffing: inspects raw binary headers (PNG, JPEG, GIF, WebP) to prevent image
 *    type spoofing. Files of any type are not sniffed: nothing claims what they contain.
 * 6. File mode: files are created with mode 0o600.
 * 7. Automatic pruning: caps at 20 files and 50 MB (oldest deleted first), removes >24h stale files at startup.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';
import { ensureDir } from 'herdr-remote-relay/state';
import {
  PASTE_CHUNK_BYTES,
  PASTE_FILE_MIME,
  PASTE_MAX_BYTES,
  PASTE_IMAGE_EXTENSIONS,
  PASTE_REQUEST_ID,
  type PasteImageMimeType,
  type RelayPasteFileBeginMessage,
  type RelayPasteFileChunkMessage,
  type RelayPasteFileMessage,
  isPasteImageMime,
  hasImageSignature,
  pasteChunkSize,
  sanitizePasteFileName,
} from 'herdr-remote-relay/protocol';

const MAX_SAVED_FILES = 20;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getPastedDir(): string {
  const dir = path.join(stateDir(), 'pasted');
  ensureDir(dir);
  return dir;
}

/**
 * Prunes the pasted directory:
 * - Removes files older than maxAgeMs (default 24 hours).
 * - Caps total file count (default 20) and total disk footprint (default 50 MB),
 *   deleting oldest files first.
 */
function cleanPastedDir({
  dir = getPastedDir(),
  maxFiles = MAX_SAVED_FILES,
  maxBytes = MAX_TOTAL_BYTES,
  maxAgeMs = MAX_AGE_MS,
  now = Date.now(),
  keepPath,
}: {
  dir?: string;
  maxFiles?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: number;
  /** The file a save just produced is never pruned away by that save. */
  keepPath?: string;
} = {}): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const fileInfos: { path: string; size: number; mtimeMs: number }[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Removed by another process meanwhile, or not ours to remove: skip it.
        }
        continue;
      }
      fileInfos.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // The file vanished between listing and stat; nothing to account for.
    }
  }

  // Sort oldest first
  fileInfos.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalSize = fileInfos.reduce((sum, f) => sum + f.size, 0);

  while (fileInfos.length > maxFiles || totalSize > maxBytes) {
    const oldest = fileInfos.shift();
    if (!oldest || oldest.path === keepPath) break;
    try {
      fs.unlinkSync(oldest.path);
      totalSize -= oldest.size;
    } catch {
      // Pruning is best effort; the next save prunes again.
    }
  }
}

/**
 * Validates base64 data, checks payload limits, sniffs magic bytes against declared MIME,
 * writes to state storage with mode 0o600, and returns the absolute local path.
 */
function savePastedFile({
  mime,
  dataBase64,
  name,
  dir = getPastedDir(),
}: {
  mime: unknown;
  dataBase64: unknown;
  name?: unknown;
  dir?: string;
}): string {
  const imageMime = isPasteImageMime(mime) ? mime : null;
  if (!imageMime && mime !== PASTE_FILE_MIME) {
    throw new Error(`unsupported MIME type: ${mime}`);
  }
  if (typeof dataBase64 !== 'string') {
    throw new Error('missing or invalid dataBase64 payload');
  }

  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.length > PASTE_MAX_BYTES) {
    throw new Error(`file size (${buf.length} bytes) exceeds maximum limit of 3 MB`);
  }
  if (buf.length === 0) {
    throw new Error('file payload is empty');
  }

  if (imageMime && !hasImageSignature(imageMime, buf)) {
    throw new Error(`file magic bytes do not match declared MIME type ${mime}`);
  }

  // Prune before writing new file
  cleanPastedDir({ dir });

  const fileName = imageMime
    ? `${crypto.randomUUID()}${PASTE_IMAGE_EXTENSIONS[imageMime]}`
    : `${crypto.randomUUID()}-${sanitizePasteFileName(name)}`;
  const filePath = path.join(dir, fileName);

  fs.writeFileSync(filePath, buf, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // The file was created 0600 already; chmod only guards against a lax umask.
  }

  // Prune again after writing to strictly observe count/size ceiling, minus
  // the file this save exists to keep.
  cleanPastedDir({ dir, keepPath: filePath });

  return filePath;
}

/**
 * Save a relay-forwarded `paste_file` and answer the asking window —
 * `paste_file_ready` with the saved path, or the matching error.
 */
function savePasteReply(
  send: (payload: Record<string, unknown>) => void,
  streamId: string | null,
  message: { mime: string; dataBase64: string; name?: string },
): void {
  try {
    const savedPath = savePastedFile({
      mime: message.mime,
      dataBase64: message.dataBase64,
      name: message.name,
    });
    send({ type: 'paste_file_ready', clientId: streamId, path: savedPath });
  } catch (error) {
    send({
      type: 'error',
      clientId: streamId,
      code: 'paste_file_write_failed',
      message: (error as Error).message || 'Failed to save pasted file',
    });
  }
}

/** Slices of one upload the workstation asks for ahead of their arrival. */
const PASTE_UPLOAD_WINDOW = 4;

/** An upload with no slice for this long is abandoned and its file removed. */
const UPLOAD_TTL_MS = 10 * 60 * 1000;

/** An upload in flight: an open file the host fills as requested slices land. */
interface ActiveUpload {
  requestId: string;
  filePath: string;
  fd: number;
  size: number;
  totalChunks: number;
  imageMime: PasteImageMimeType | null;
  /** Slices asked for and not yet arrived. */
  pending: Set<number>;
  nextToRequest: number;
  received: number;
  touchedAtMs: number;
}

/**
 * Chunked uploads: a window announces `paste_file_begin`, and the host pulls
 * the file a few slices at a time with `paste_file_chunk_request`, writing
 * each where it belongs. Slices never queue a whole file in memory, and no
 * single message carries it — which is what lets an upload outlast a
 * connection's appetite for one giant payload.
 */
export class PasteUploads {
  private readonly send: (payload: Record<string, unknown>) => void;
  private readonly dir: string | undefined;
  private readonly uploads = new Map<string, ActiveUpload>();

  constructor(send: (payload: Record<string, unknown>) => void, dir?: string) {
    this.send = send;
    this.dir = dir;
  }

  /** All paste_* requests, one entry point for the connector's message switch. */
  handle(
    streamId: string | null,
    message: RelayPasteFileMessage | RelayPasteFileBeginMessage | RelayPasteFileChunkMessage,
  ): void {
    switch (message.type) {
      case 'paste_file':
        savePasteReply(this.send, streamId, message);
        return;
      case 'paste_file_begin':
        this.begin(streamId, message);
        return;
      case 'paste_file_chunk':
        this.chunk(streamId, message);
        return;
    }
  }

  /** `paste_file_begin`: open the file and pull the first slices. */
  begin(streamId: string | null, message: RelayPasteFileBeginMessage): void {
    this.sweep();
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const fail = (code: string, text: string) =>
      this.send({ type: 'error', clientId: streamId, code, message: text, requestId });
    if (!PASTE_REQUEST_ID.test(requestId)) return;
    const imageMime = isPasteImageMime(message.mime) ? message.mime : null;
    if (!imageMime && message.mime !== PASTE_FILE_MIME) {
      fail('paste_file_unsupported', `unsupported MIME type: ${message.mime}`);
      return;
    }
    const size = typeof message.size === 'number' ? message.size : 0;
    if (!Number.isSafeInteger(size) || size <= 0) {
      fail('paste_file_empty', 'upload payload is empty');
      return;
    }
    const key = `${streamId} ${requestId}`;
    // A request id may not restart a live upload under a different file.
    const stale = this.uploads.get(key);
    if (stale) this.discard(key, stale);
    const dir = this.dir || getPastedDir();
    ensureDir(dir);
    cleanPastedDir({ dir });
    const fileName = imageMime
      ? `${crypto.randomUUID()}${PASTE_IMAGE_EXTENSIONS[imageMime]}`
      : `${crypto.randomUUID()}-${sanitizePasteFileName(message.name)}`;
    const filePath = path.join(dir, fileName);
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'wx', 0o600);
    } catch (error) {
      fail('paste_file_write_failed', (error as Error).message);
      return;
    }
    const upload: ActiveUpload = {
      requestId,
      filePath,
      fd,
      size,
      totalChunks: Math.max(1, Math.ceil(size / PASTE_CHUNK_BYTES)),
      imageMime,
      pending: new Set(),
      nextToRequest: 0,
      received: 0,
      touchedAtMs: Date.now(),
    };
    this.uploads.set(key, upload);
    this.requestMore(streamId, upload);
  }

  /** `paste_file_chunk`: one slice the host asked for, written where it belongs. */
  chunk(streamId: string | null, message: RelayPasteFileChunkMessage): void {
    this.sweep();
    const upload = this.uploads.get(`${streamId} ${message.requestId}`);
    if (!upload || !Number.isInteger(message.index) || typeof message.dataBase64 !== 'string') {
      return;
    }
    const index = message.index as number;
    // A slice never asked for — duplicated, pushed uninvited — is not this file's.
    if (!upload.pending.has(index)) return;
    const fail = (code: string, text: string) =>
      this.abort(streamId, `${streamId} ${upload.requestId}`, upload, code, text);
    const buf = Buffer.from(message.dataBase64, 'base64');
    if (buf.length !== pasteChunkSize(upload.size, upload.totalChunks, index)) {
      fail('paste_file_corrupt', `slice ${index} is ${buf.length} bytes`);
      return;
    }
    if (upload.imageMime && index === 0 && !hasImageSignature(upload.imageMime, buf)) {
      fail('paste_file_corrupt', `image content does not match declared MIME type`);
      return;
    }
    try {
      fs.writeSync(upload.fd, buf, 0, buf.length, index * PASTE_CHUNK_BYTES);
    } catch (error) {
      fail('paste_file_write_failed', (error as Error).message);
      return;
    }
    upload.pending.delete(index);
    upload.received += 1;
    upload.touchedAtMs = Date.now();
    if (upload.received === upload.totalChunks) {
      this.finish(streamId, `${streamId} ${upload.requestId}`, upload);
      return;
    }
    this.requestMore(streamId, upload);
  }

  /** Keep the pull window full: a few slices in flight, never the file at once. */
  private requestMore(streamId: string | null, upload: ActiveUpload): void {
    while (upload.pending.size < PASTE_UPLOAD_WINDOW && upload.nextToRequest < upload.totalChunks) {
      const index = upload.nextToRequest++;
      upload.pending.add(index);
      this.send({
        type: 'paste_file_chunk_request',
        clientId: streamId,
        requestId: upload.requestId,
        index,
      });
    }
  }

  /** Every slice landed: seal the file and answer the window its path. */
  private finish(streamId: string | null, key: string, upload: ActiveUpload): void {
    this.uploads.delete(key);
    try {
      fs.closeSync(upload.fd);
    } catch {
      // Already closed; the file is complete either way.
    }
    cleanPastedDir({ dir: path.dirname(upload.filePath), keepPath: upload.filePath });
    this.send({
      type: 'paste_file_ready',
      clientId: streamId,
      requestId: upload.requestId,
      path: upload.filePath,
    });
  }

  /** An upload that can never finish: close it, erase the partial file, say why. */
  private abort(
    streamId: string | null,
    key: string,
    upload: ActiveUpload,
    code: string,
    message: string,
  ): void {
    this.discard(key, upload);
    this.send({ type: 'error', clientId: streamId, code, message, requestId: upload.requestId });
  }

  /** A stream that is gone takes its unfinished uploads and their files with it. */
  drop(streamId: string | null): void {
    const prefix = `${streamId} `;
    for (const [key, upload] of [...this.uploads]) {
      if (key.startsWith(prefix)) this.discard(key, upload);
    }
  }

  stopAll(): void {
    for (const [key, upload] of [...this.uploads]) this.discard(key, upload);
  }

  private discard(key: string, upload: ActiveUpload): void {
    this.uploads.delete(key);
    try {
      fs.closeSync(upload.fd);
    } catch {
      // Already closed.
    }
    try {
      fs.rmSync(upload.filePath, { force: true });
    } catch {
      // A leftover partial is swept with the directory's ordinary pruning.
    }
  }

  /** Abandon uploads a stalled window stopped feeding. */
  private sweep(now = Date.now()): void {
    for (const [key, upload] of [...this.uploads]) {
      if (now - upload.touchedAtMs <= UPLOAD_TTL_MS) continue;
      const streamId = key.slice(0, key.indexOf(' '));
      this.abort(streamId, key, upload, 'paste_file_write_failed', 'upload timed out');
    }
  }
}

export { cleanPastedDir, savePastedFile };
