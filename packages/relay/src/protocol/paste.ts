// Rules for an image pasted in a browser: the browser compresses to fit them,
// the relay refuses what breaks them, and the host checks again before it
// writes a file. Browser-safe: no Node APIs.

/** Largest decoded image a browser may paste. */
export const PASTE_MAX_BYTES = 3 * 1024 * 1024;

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
