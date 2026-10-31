/**
 * Secure file storage and validation for pasted clipboard images and uploaded files.
 *
 * Security requirements:
 * 1. Pinned directory: writes strictly to path.join(stateDir(), 'pasted') (directory mode 0o700).
 * 2. Unpredictable filename: starts with crypto.randomUUID(); a client-provided name is only
 *    appended to a file's UUID after sanitizePasteFileName, never used as a path.
 * 3. Whitelisted extension: an image's is derived exclusively from its verified MIME type.
 * 4. Host-side size check: re-validated to enforce <= 3 MB independently of relay checks.
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
  PASTE_FILE_MIME,
  PASTE_MAX_BYTES,
  PASTE_IMAGE_EXTENSIONS,
  isPasteImageMime,
  hasImageSignature,
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
    if (!oldest) break;
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

  // Prune again after writing to strictly observe count/size ceiling
  cleanPastedDir({ dir });

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

export { cleanPastedDir, savePastedFile, savePasteReply };
