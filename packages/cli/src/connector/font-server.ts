// Serving the workstation's terminal font to browser windows: its public
// description, its files a chunk at a time, and characters cut out of large
// (CJK) fonts on demand.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { TERMINAL_FONT_CHUNK_BYTES } from 'herdr-remote-relay/protocol';
import { FontSubsetter } from '../font-subset.js';
import type { LocalSubsetSource } from '../terminal-font/files.js';
import {
  type LocalTerminalFont,
  loadHostTerminalFont,
  publicTerminalFont,
  readFontChunk,
} from '../terminal-font/index.js';

/** Cut fonts kept for the slices a browser has yet to fetch, by total size. */
const FONT_SUBSET_CACHE_BYTES = 48 * 1024 * 1024;

const FONT_CHANGED = 'The terminal font changed or is no longer on this workstation';

export type LoadTerminalFont = (options?: { refresh?: boolean }) => LocalTerminalFont | null;

export interface FontServerOptions {
  /** The font to start with; loaded now when left out. */
  terminalFont?: LocalTerminalFont | null;
  loadTerminalFont?: LoadTerminalFont;
  fontSubsetter?: FontSubsetter;
}

interface ChunkRequest {
  sha256: string;
  index: number;
}

interface SubsetRequest {
  requestId: string;
  sha256: string;
  text: string;
}

/**
 * Only the family, size and file hashes leave this process; a browser that
 * lacks the font fetches the files by hash, one chunk at a time.
 */
export class FontServer {
  font: LocalTerminalFont | null;
  private readonly load: LoadTerminalFont;
  private readonly subsetter: FontSubsetter;
  /** Subsets too large for one message, by hash, until fetched. */
  private readonly subsets = new Map<string, Buffer>();
  private readonly send: (payload: unknown) => void;

  constructor(options: FontServerOptions, send: (payload: unknown) => void) {
    this.load = options.loadTerminalFont || loadHostTerminalFont;
    this.font = options.terminalFont !== undefined ? options.terminalFont : this.load();
    this.subsetter = options.fontSubsetter || new FontSubsetter();
    this.send = send;
  }

  /** What may leave this machine: the record without its file paths. */
  publicFont() {
    return publicTerminalFont(this.font);
  }

  /**
   * A service started at boot runs before anything has seen a terminal, so it
   * starts with no font. The first `herdr-remote start` from a terminal (or
   * from Herdr's plugin hook) writes one down; the next window to open picks
   * it up here instead of waiting for a restart.
   */
  pickUp(): void {
    if (this.font) return;
    let next: LocalTerminalFont | null = null;
    try {
      next = this.load();
    } catch {
      // Unreadable now; the next window to open asks again.
      return;
    }
    if (!next) return;
    this.font = next;
    this.send({ type: 'terminal_font', terminalFont: publicTerminalFont(next) });
  }

  /**
   * Read the terminal's font settings again, at a browser's request. Every
   * window of this workstation hears the answer, since they all draw with it.
   */
  refresh(): void {
    try {
      const next = this.load({ refresh: true });
      if (next) this.font = next;
    } catch (error) {
      process.stderr.write(
        `herdr-remote host connector: could not read the terminal font: ${(error as Error).message}\n`,
      );
    }
    this.send({ type: 'terminal_font', terminalFont: this.publicFont() });
  }

  /** One slice of a terminal font file, for the window that asked for it. */
  sendChunk(streamId: string | null, request: ChunkRequest): void {
    const chunk =
      this.subsetChunk(request.sha256, request.index) ||
      readFontChunk(this.font, request.sha256, request.index);
    if (!chunk) {
      this.send({
        type: 'error',
        clientId: streamId,
        code: 'host_font_unavailable',
        message: FONT_CHANGED,
      });
      return;
    }
    this.send({
      type: 'host_font_chunk',
      clientId: streamId,
      sha256: request.sha256,
      index: request.index,
      total: chunk.total,
      dataBase64: chunk.data.toString('base64'),
    });
  }

  /**
   * The characters a window is about to draw, cut out of a large font (CJK).
   * A small result travels in the answer itself; a large one (the common
   * characters fetched up front) is held here and pulled in slices.
   */
  sendSubset(streamId: string | null, request: SubsetRequest): void {
    const fail = (code: string, text: string) =>
      this.send({ type: 'error', clientId: streamId, code, message: text });
    const source = this.font?.subsets?.find((candidate) => candidate.sha256 === request.sha256);
    if (!source || !this.unchanged(source)) {
      fail('host_font_unavailable', FONT_CHANGED);
      return;
    }
    const codepoints = [
      ...new Set(Array.from(String(request.text || ''), (char) => char.codePointAt(0) as number)),
    ];
    let data: Buffer;
    try {
      data = this.subsetter.subset(source, codepoints);
    } catch (error) {
      fail('host_font_subset_failed', (error as Error).message || 'The font could not be subset');
      return;
    }
    const subsetSha = crypto.createHash('sha256').update(data).digest('hex');
    const answer: Record<string, unknown> = {
      type: 'host_font_subset_ready',
      clientId: streamId,
      requestId: request.requestId,
      sha256: source.sha256,
      subsetSha,
      bytes: data.length,
    };
    if (data.length <= TERMINAL_FONT_CHUNK_BYTES) {
      answer.dataBase64 = data.toString('base64');
    } else {
      this.hold(subsetSha, data);
    }
    this.send(answer);
  }

  /** Whether the file behind `source` is still the one that was announced. */
  private unchanged(source: LocalSubsetSource): boolean {
    try {
      const stat = fs.statSync(source.path);
      return stat.size === source.bytes && stat.mtimeMs === source.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Keep a cut font for its slices, dropping the oldest beyond the cache size. */
  private hold(subsetSha: string, data: Buffer): void {
    this.subsets.delete(subsetSha);
    this.subsets.set(subsetSha, data);
    let held = [...this.subsets.values()].reduce((sum, item) => sum + item.length, 0);
    for (const [key, item] of this.subsets) {
      if (held <= FONT_SUBSET_CACHE_BYTES || key === subsetSha) break;
      this.subsets.delete(key);
      held -= item.length;
    }
  }

  /** A slice of a cut font still held for the browser that asked for it. */
  private subsetChunk(sha256: string, index: number): { data: Buffer; total: number } | null {
    const data = this.subsets.get(sha256);
    if (!data) return null;
    const total = Math.ceil(data.length / TERMINAL_FONT_CHUNK_BYTES);
    if (!Number.isInteger(index) || index < 0 || index >= total) return null;
    const start = index * TERMINAL_FONT_CHUNK_BYTES;
    return { data: data.subarray(start, start + TERMINAL_FONT_CHUNK_BYTES), total };
  }
}
