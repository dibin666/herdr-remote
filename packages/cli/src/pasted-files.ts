/**
 * Secure file storage and validation for pasted clipboard images.
 *
 * Security requirements:
 * 1. Pinned directory: writes strictly to path.join(stateDir(), 'pasted') (directory mode 0o700).
 * 2. Unpredictable filename: generated via crypto.randomUUID(), never using client-provided strings.
 * 3. Whitelisted extension: derived exclusively from verified MIME type.
 * 4. Host-side size check: re-validated to enforce <= 3 MB independently of relay checks.
 * 5. Magic bytes sniffing: inspects raw binary headers (PNG, JPEG, GIF, WebP) to prevent file-type spoofing.
 * 6. File mode: files are created with mode 0o600.
 * 7. Automatic pruning: caps at 20 files and 50 MB (oldest deleted first), removes >24h stale files at startup.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';
import { ensureDir } from 'herdr-remote-relay/state';
import {
  PASTE_MAX_BYTES,
  PASTE_IMAGE_EXTENSIONS,
  isPasteImageMime,
  hasImageSignature,
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
        } catch {}
        continue;
      }
      fileInfos.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
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
    } catch {}
  }
}

/**
 * Validates base64 data, checks payload limits, sniffs magic bytes against declared MIME,
 * writes to state storage with mode 0o600, and returns the absolute local path.
 */
function savePastedFile({
  mime,
  dataBase64,
  dir = getPastedDir(),
}: {
  mime: unknown;
  dataBase64: unknown;
  dir?: string;
}): string {
  if (!isPasteImageMime(mime)) {
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

  if (!hasImageSignature(mime, buf)) {
    throw new Error(`file magic bytes do not match declared MIME type ${mime}`);
  }

  // Prune before writing new file
  cleanPastedDir({ dir });

  const fileName = `${crypto.randomUUID()}${PASTE_IMAGE_EXTENSIONS[mime]}`;
  const filePath = path.join(dir, fileName);

  fs.writeFileSync(filePath, buf, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}

  // Prune again after writing to strictly observe count/size ceiling
  cleanPastedDir({ dir });

  return filePath;
}

export { cleanPastedDir, savePastedFile };
