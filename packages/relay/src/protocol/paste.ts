// Rules for an image or file pasted in a browser: the browser compresses or
// refuses to fit them, the relay refuses what breaks them, and the host checks
// again before it writes a file. Browser-safe: no Node APIs.

/** Largest decoded image or file a browser may paste. */
export const PASTE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The MIME a paste carries when it is any file rather than an image. Its bytes
 * are never sniffed, so it is saved under its (sanitized) name, not a type.
 */
export const PASTE_FILE_MIME = 'application/octet-stream';

/** Longest file name, in characters, a pasted file keeps on the host. */
export const PASTE_FILE_NAME_MAX_CHARS = 120;

/**
 * A pasted file's name made safe to save and to paste into a shell unquoted:
 * no directories, no hidden files, nothing but letters, digits, `.`, `_` and
 * `-`. A name with nothing left becomes `file`.
 */
export function sanitizePasteFileName(name: unknown): string {
  if (typeof name !== 'string') return 'file';
  const base = name.normalize('NFC').split(/[\\/]/).pop() ?? '';
  let safe = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    // Leading dots would hide the file; trailing ones Windows drops silently.
    .replace(/^[._]+|[._]+$/g, '');
  if ([...safe].length > PASTE_FILE_NAME_MAX_CHARS) {
    const dot = safe.lastIndexOf('.');
    // Keep a short extension: it is what tells an agent what the file is.
    const ext = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : '';
    const stem = [...safe.slice(0, safe.length - ext.length)];
    safe = stem.slice(0, PASTE_FILE_NAME_MAX_CHARS - ext.length).join('') + ext;
  }
  return safe || 'file';
}

/** Image types a paste may carry, with the extension the host saves them under. */
export const PASTE_IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
} as const;

export type PasteImageMimeType = keyof typeof PASTE_IMAGE_EXTENSIONS;

export const PASTE_IMAGE_MIME_TYPES = Object.keys(PASTE_IMAGE_EXTENSIONS) as PasteImageMimeType[];

export function isPasteImageMime(value: unknown): value is PasteImageMimeType {
  return typeof value === 'string' && Object.hasOwn(PASTE_IMAGE_EXTENSIONS, value);
}

/** Whether `bytes` begin with the file signature `mime` promises. */
export function hasImageSignature(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        // 'RIFF'
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        // 'WEBP'
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/gif':
      // 'GIF8'
      return (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
      );
    default:
      return false;
  }
}
