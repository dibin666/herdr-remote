/**
 * Client-side image processing and compression pipeline for terminal pasting.
 *
 * Why this pipeline exists:
 *
 * 1. Semantic mismatch: Terminal emulators run character grids and cannot directly
 *    display or ingest arbitrary binary image payloads. However, AI coding agents
 *    (Claude Code, Pi, Herdr workflows) operating inside the session accept local
 *    filesystem paths. We bridge this by uploading the image to the host, storing it
 *    in the host's private state directory, and pasting the resulting path into the PTY.
 *
 * 2. Resolution vs Agent Utility:
 *    Modern smartphone cameras and high-DPI displays routinely capture images at
 *    4000x3000 (12-20 MP) or higher. Feeding full-resolution images wastes cellular
 *    bandwidth and workstation storage without providing any additional cognitive value
 *    to vision-enabled language models, whose vision encoders downsample inputs to
 *    roughly 1568px on the longest dimension anyway. We clamp the longest edge to 1568px.
 *    Images smaller than 1568px are never upscaled.
 *
 * 3. Strict Payload Ceiling:
 *    The WebSocket server enforces a strict `maxPayload` limit (configured at 5 MiB in
 *    the relay). Frame overflow triggers an immediate hard WebSocket closure with code 1009
 *    rather than a simple frame drop. Because Base64 encoding expands raw binary by ~33%,
 *    the raw image payload is strictly capped at 3 MB (`MAX_PASTE_BYTES = 3 * 1024 * 1024`),
 *    matching the host validator in `packages/cli/src/pasted-files.js`.
 *    If an image exceeds 3 MB at quality 0.85, we gracefully step down through quality
 *    tiers (0.85 -> 0.7 -> 0.55 -> 0.4). If it still exceeds 3 MB, compression fails
 *    gracefully so the UI can reject it with a toast without terminating the connection.
 *
 * 4. Content Security Policy (CSP):
 *    The relay server serves the web application under `img-src 'self' data:`.
 *    Blob URLs (`blob:http://...`) are blocked by modern browser CSP directives.
 *    Consequently, client-side preview thumbnails MUST use `data:` URLs, never `blob:` URLs.
 */

export const MAX_LONG_EDGE = 1568;
export const MAX_PASTE_BYTES = 3 * 1024 * 1024; // 3 MB raw payload ceiling
export const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

export interface PreparedImagePaste {
  mime: string;
  dataBase64: string;
  /** CSP-compliant `data:` URL suitable for immediate thumbnail rendering in <img src>. */
  dataUrl: string;
  /** Decoded raw binary byte length. Guaranteed to be <= MAX_PASTE_BYTES. */
  byteLength: number;
  width: number;
  height: number;
}
export type ImageUploadPhase =
  | 'idle'
  | 'reading'
  | 'processing'
  | 'sending'
  | 'waitingHost'
  | 'completed'
  | 'error';

export interface ImageUploadProgress {
  active: boolean;
  phase: ImageUploadPhase;
  ratio: number; // 0..1
  percent: number; // 0..100
  statusText: string;
  error?: string;
}

export const IDLE_IMAGE_UPLOAD_PROGRESS: ImageUploadProgress = {
  active: false,
  phase: 'idle',
  ratio: 0,
  percent: 0,
  statusText: '',
};

/**
 * Calculates proportional dimensions keeping aspect ratio intact,
 * capping the longest edge at `maxLongEdge` without upscaling smaller dimensions.
 */
export function calculateScaledDimensions(
  width: number,
  height: number,
  maxLongEdge = MAX_LONG_EDGE
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width, height };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Calculates raw byte size of a Base64 string taking padding characters into account.
 */
export function getBase64ByteLength(base64: string): number {
  if (typeof base64 !== 'string' || base64.length === 0) return 0;
  const len = base64.length;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  const bytes = Math.floor((len * 3) / 4) - padding;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/**
 * Formats byte size into human-readable units (B, KB, MB) for display in modals.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DecodedSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup?: () => void;
}

/**
 * Decodes a raw image Blob using `createImageBitmap` where available (non-blocking offscreen decode),
 * falling back to HTML `Image` with object URL for environments or formats where ImageBitmap fails.
 * Applies EXIF orientation metadata where supported (`imageOrientation: 'from-image'`).
 */
async function decodeImageSource(blob: Blob): Promise<DecodedSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      // EXIF orientation: 'from-image' automatically corrects photo rotation on mobile devices
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => {
          if (typeof bitmap.close === 'function') {
            bitmap.close();
          }
        },
      };
    } catch {
      try {
        const bitmap = await createImageBitmap(blob);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => {
            if (typeof bitmap.close === 'function') {
              bitmap.close();
            }
          },
        };
      } catch {
        // Fall through to Image + onload fallback
      }
    }
  }

  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      return reject(new Error('Image decoding not supported in this environment'));
    }
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => {
          try {
            URL.revokeObjectURL(url);
          } catch {}
        },
      });
    };
    img.onerror = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
      reject(new Error('Failed to decode image source'));
    };
    img.src = url;
  });
}

/**
 * Compresses and scales an image Blob down to <= 1568px long edge and <= 3 MB payload.
 *
 * Export preference:
 *   - Attempts `image/webp` first with quality 0.85.
 *   - If the browser environment cannot export WebP (indicated by canvas returning a fallback
 *     data URL like image/png), falls back to `image/jpeg`.
 *   - If the output exceeds 3 MB, steps down through [0.85, 0.7, 0.55, 0.4].
 *   - If even at 0.4 the payload exceeds 3 MB, returns `null` so the UI can reject safely.
 */
export async function compressAndPrepareImage(
  blob: Blob,
  maxLongEdge = MAX_LONG_EDGE,
  maxBytes = MAX_PASTE_BYTES
): Promise<PreparedImagePaste | null> {
  if (!blob || blob.size === 0) {
    return null;
  }
  if (blob.type && !blob.type.startsWith('image/')) {
    return null;
  }

  let decoded: DecodedSource;
  try {
    decoded = await decodeImageSource(blob);
  } catch (err) {
    console.warn('Failed to decode image for paste:', err);
    return null;
  }

  try {
    const { width: targetWidth, height: targetHeight } = calculateScaledDimensions(
      decoded.width,
      decoded.height,
      maxLongEdge
    );

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    // Detect WebP export capability. Modern Chrome, Firefox, Safari 14+, Edge support WebP.
    // When unsupported, toDataURL falls back to 'image/png'.
    let preferredMime = 'image/webp';
    try {
      const probeUrl = canvas.toDataURL('image/webp', 0.85);
      if (!probeUrl.startsWith('data:image/webp')) {
        preferredMime = 'image/jpeg';
      }
    } catch {
      preferredMime = 'image/jpeg';
    }

    for (const quality of QUALITY_STEPS) {
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL(preferredMime, quality);
      } catch {
        continue;
      }

      if (!dataUrl || !dataUrl.startsWith('data:')) {
        continue;
      }

      const commaIdx = dataUrl.indexOf(',');
      const dataBase64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : '';
      const byteLength = getBase64ByteLength(dataBase64);

      if (byteLength <= maxBytes) {
        return {
          mime: preferredMime,
          dataBase64,
          dataUrl,
          byteLength,
          width: targetWidth,
          height: targetHeight,
        };
      }
    }

    // Even at the lowest quality threshold, the compressed image exceeds 3 MB limit.
    return null;
  } finally {
    decoded.cleanup?.();
  }
}
