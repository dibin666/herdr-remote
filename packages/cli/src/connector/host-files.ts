// The workstation side of file browsing: what the terminal's working
// directory holds, and the files a window picks out of it.
//
// "The terminal's directory" is the focused pane's own, asked of Herdr's
// socket API rather than guessed from the PTY — the PTY's cwd is the client's
// spawn directory, which a `cd` inside the session left behind long ago.
//
// A window downloads only what it was just shown: `fs_list_request` records
// the directory and the entry names it answered with, and
// `fs_download_request` may pick names out of that listing and nothing else —
// no client-supplied path ever reaches the filesystem.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FS_DOWNLOAD_CHUNK_BYTES,
  FS_DOWNLOAD_MAX_BYTES,
  FS_LIST_MAX_ENTRIES,
  FS_PREVIEW_MAX_BYTES,
  type FsListEntry,
  isFsEntryName,
  type RelayFsRequestMessage,
  sanitizePasteFileName,
} from 'herdr-remote-relay/protocol';
import { ensureDir } from 'herdr-remote-relay/state';
import { requestHerdr } from '../herdr-api.js';
import { stateDir } from '../paths.js';
import { buildZipArchive, type ZipEntry } from '../zip-archive.js';

/** A staged transfer a window stopped pulling is dropped after this long. */
const TRANSFER_TTL_MS = 10 * 60 * 1000;

/** Bytes a zip may gather before it is even built. */
const ZIP_INPUT_MAX_BYTES = FS_DOWNLOAD_MAX_BYTES;

interface Listing {
  dir: string;
  /** Entry name → kind, exactly what the window was shown. */
  entries: Map<string, 'file' | 'dir'>;
}

interface Transfer {
  /** What the chunks are read from: the file itself, or a built zip. */
  filePath: string;
  name: string;
  size: number;
  totalChunks: number;
  fd: number | null;
  /** A zip the connector wrote; deleted when the transfer ends. */
  temporary: boolean;
  touchedAtMs: number;
}

export interface HostFilesOptions {
  /** Herdr's API socket, where `pane.current` says which directory is on screen. */
  socketPath: string;
  /** Where the terminal session was spawned; the answer when Herdr cannot say. */
  fallbackCwd: string;
  downloadsDir?: string;
  requestHerdr?: typeof requestHerdr;
}

export class HostFiles {
  private readonly socketPath: string;
  private readonly fallbackCwd: string;
  private readonly downloadsDir: string;
  private readonly request: typeof requestHerdr;
  private readonly send: (payload: unknown) => void;

  private readonly listings = new Map<string, Listing>();
  private readonly transfers = new Map<string, Transfer>();

  constructor(options: HostFilesOptions, send: (payload: unknown) => void) {
    this.socketPath = options.socketPath;
    this.fallbackCwd = options.fallbackCwd;
    this.request = options.requestHerdr || requestHerdr;
    this.send = send;
    this.downloadsDir = options.downloadsDir || path.join(stateDir(), 'downloads');
    // Zips of abandoned downloads from a previous run have no owner left.
    try {
      for (const stale of fs.readdirSync(this.downloadsDir)) {
        if (stale.endsWith('.zip')) fs.rmSync(path.join(this.downloadsDir, stale), { force: true });
      }
    } catch {
      // Nothing staged yet, or a directory we cannot read; either way nothing to do.
    }
  }

  /** All fs_* requests, one entry point for the connector's message switch. */
  handle(streamId: string | null, message: RelayFsRequestMessage): Promise<void> | undefined {
    switch (message.type) {
      case 'fs_list_request':
        return this.list(streamId, message.requestId, message.dir);
      case 'fs_download_request':
        return this.download(streamId, message.requestId, message.names);
      case 'fs_download_chunk_request':
        this.sendChunk(streamId, message.requestId, message.index);
        return undefined;
      case 'fs_preview_request':
        this.preview(streamId, message.requestId, message.name);
        return undefined;
      case 'fs_rename_request':
        this.rename(streamId, message.requestId, message.name, message.newName);
        return undefined;
      case 'fs_delete_request':
        this.remove(streamId, message.requestId, message.name);
        return undefined;
    }
  }

  /** The directory the terminal is sitting in, best the workstation knows. */
  private async currentDirectory(): Promise<string> {
    try {
      const result = await this.request<{
        pane?: { foreground_cwd?: unknown; cwd?: unknown };
      }>(this.socketPath, 'pane.current', {});
      const pane = result?.pane;
      const dir =
        typeof pane?.foreground_cwd === 'string' && pane.foreground_cwd
          ? pane.foreground_cwd
          : pane?.cwd;
      if (typeof dir === 'string' && dir) return dir;
    } catch {
      // Herdr away or restarting: the session's spawn directory still answers.
    }
    return this.fallbackCwd;
  }

  private fail(streamId: string | null, requestId: string, code: string, message: string): void {
    this.send({ type: 'error', clientId: streamId, code, message, requestId });
  }

  /** Drop staged transfers a window abandoned. */
  private sweep(now = Date.now()): void {
    for (const [key, transfer] of this.transfers) {
      if (now - transfer.touchedAtMs > TRANSFER_TTL_MS) this.closeTransfer(key);
    }
  }

  /**
   * `fs_list_request`: answer what the terminal's directory holds — or, when
   * `dir` is given, move relative to this stream's last listing: `'.'` re-reads
   * it, `'..'` steps up, another value must name a directory it contained, so
   * a window can only ever reach what it was shown (and parents of it).
   */
  async list(streamId: string | null, requestId: string, dir?: unknown): Promise<void> {
    this.sweep();
    let target: string;
    if (dir === undefined) {
      target = await this.currentDirectory();
    } else {
      const previous = this.listings.get(streamId ?? '');
      if (!previous) {
        this.fail(streamId, requestId, 'fs_list_failed', 'nothing listed to navigate from');
        return;
      }
      if (dir === '.') {
        target = previous.dir;
      } else if (dir === '..') {
        target = path.dirname(previous.dir);
      } else if (typeof dir === 'string' && previous.entries.get(dir) === 'dir') {
        target = path.join(previous.dir, dir);
      } else {
        this.fail(streamId, requestId, 'fs_not_found', 'no such listed directory');
        return;
      }
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      this.fail(streamId, requestId, 'fs_list_failed', (error as Error).message);
      return;
    }
    const listing: Listing = { dir: target, entries: new Map() };
    const entries: FsListEntry[] = [];
    for (const dirent of dirents) {
      if (entries.length >= FS_LIST_MAX_ENTRIES) break;
      if (!isFsEntryName(dirent.name)) continue;
      const kind = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : null;
      // Links stay out: nothing a name points at outside this directory is listed.
      if (!kind) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(target, dirent.name));
      } catch {
        // Vanished or unreadable between readdir and stat: not an entry to show.
        continue;
      }
      listing.entries.set(dirent.name, kind);
      entries.push({
        name: dirent.name,
        kind,
        size: kind === 'file' ? stat.size : 0,
        mtimeMs: Math.floor(stat.mtimeMs),
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.listings.set(streamId ?? '', listing);
    this.send({
      type: 'fs_list_response',
      clientId: streamId,
      requestId,
      cwd: target,
      entries,
    });
  }

  /** `fs_preview_request`: read the start of a listed file's text. */
  preview(streamId: string | null, requestId: string, name: unknown): void {
    this.sweep();
    const listing = this.listings.get(streamId ?? '');
    if (!listing || !isFsEntryName(name) || listing.entries.get(name) !== 'file') {
      this.fail(streamId, requestId, 'fs_not_found', 'no such listed file');
      return;
    }
    const filePath = path.join(listing.dir, name);
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (error) {
      this.fail(streamId, requestId, 'fs_not_found', (error as Error).message);
      return;
    }
    try {
      const stat = fs.fstatSync(fd);
      const cap = Math.min(stat.size, FS_PREVIEW_MAX_BYTES);
      const buffer = Buffer.alloc(cap);
      const read = fs.readSync(fd, buffer, 0, cap, 0);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read));
      } catch {
        this.fail(streamId, requestId, 'fs_not_text', 'not a text file');
        return;
      }
      this.send({
        type: 'fs_preview_response',
        clientId: streamId,
        requestId,
        name,
        text,
        truncated: stat.size > cap,
      });
    } catch (error) {
      this.fail(streamId, requestId, 'fs_preview_failed', (error as Error).message);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** `fs_rename_request`: give a listed entry a new name in the same directory. */
  rename(streamId: string | null, requestId: string, name: unknown, newName: unknown): void {
    this.sweep();
    const listing = this.listings.get(streamId ?? '');
    const kind = listing?.entries.get(name as string);
    if (!listing || !isFsEntryName(name) || !kind) {
      this.fail(streamId, requestId, 'fs_not_found', 'no such listed entry');
      return;
    }
    if (!isFsEntryName(newName)) {
      this.fail(streamId, requestId, 'fs_rename_failed', 'not a usable name');
      return;
    }
    if (newName === name) {
      this.send({ type: 'fs_mutation_done', clientId: streamId, requestId });
      return;
    }
    const next = path.join(listing.dir, newName);
    if (fs.existsSync(next)) {
      this.fail(streamId, requestId, 'fs_exists', `already exists: ${newName}`);
      return;
    }
    try {
      fs.renameSync(path.join(listing.dir, name), next);
    } catch (error) {
      this.fail(streamId, requestId, 'fs_rename_failed', (error as Error).message);
      return;
    }
    // Keep the window's whitelist true: the old name is gone, the new is in.
    listing.entries.delete(name);
    listing.entries.set(newName, kind);
    this.send({ type: 'fs_mutation_done', clientId: streamId, requestId });
  }

  /** `fs_delete_request`: remove a listed entry, a directory with all inside. */
  remove(streamId: string | null, requestId: string, name: unknown): void {
    this.sweep();
    const listing = this.listings.get(streamId ?? '');
    if (!listing || !isFsEntryName(name) || !listing.entries.has(name)) {
      this.fail(streamId, requestId, 'fs_not_found', 'no such listed entry');
      return;
    }
    try {
      fs.rmSync(path.join(listing.dir, name), { recursive: true });
    } catch (error) {
      this.fail(streamId, requestId, 'fs_delete_failed', (error as Error).message);
      return;
    }
    listing.entries.delete(name);
    this.send({ type: 'fs_mutation_done', clientId: streamId, requestId });
  }

  /** `fs_download_request`: stage the picked names, then say it is ready. */
  async download(streamId: string | null, requestId: string, names: unknown): Promise<void> {
    this.sweep();
    const listing = this.listings.get(streamId ?? '');
    const picked = Array.isArray(names) ? [...new Set(names.filter(isFsEntryName))] : [];
    if (!listing || picked.length === 0) {
      this.fail(streamId, requestId, 'fs_download_failed', 'list the directory first');
      return;
    }
    for (const name of picked) {
      if (!listing.entries.has(name)) {
        this.fail(streamId, requestId, 'fs_not_found', `no such entry: ${name}`);
        return;
      }
    }
    try {
      const transfer =
        picked.length === 1 && listing.entries.get(picked[0]) === 'file'
          ? this.stageFile(listing.dir, picked[0])
          : this.stageZip(listing, picked);
      const key = `${streamId} ${requestId}`;
      this.transfers.set(key, transfer);
      this.send({
        type: 'fs_download_ready',
        clientId: streamId,
        requestId,
        name: transfer.name,
        size: transfer.size,
        totalChunks: transfer.totalChunks,
      });
    } catch (error) {
      const code =
        (error as NodeJS.ErrnoException).code === 'fs_too_large'
          ? 'fs_too_large'
          : (error as NodeJS.ErrnoException).code === 'fs_not_found'
            ? 'fs_not_found'
            : 'fs_download_failed';
      this.fail(streamId, requestId, code, (error as Error).message);
    }
  }

  /** One file stays itself: read straight from the directory it was listed in. */
  private stageFile(dir: string, name: string): Transfer {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile())
      throw Object.assign(new Error(`not a file: ${name}`), { code: 'fs_not_found' });
    if (stat.size > FS_DOWNLOAD_MAX_BYTES) {
      throw Object.assign(new Error(`file exceeds ${FS_DOWNLOAD_MAX_BYTES} bytes`), {
        code: 'fs_too_large',
      });
    }
    return {
      filePath,
      name,
      size: stat.size,
      totalChunks: Math.max(1, Math.ceil(stat.size / FS_DOWNLOAD_CHUNK_BYTES)),
      fd: null,
      temporary: false,
      touchedAtMs: Date.now(),
    };
  }

  /** Anything beyond one file — several names, or a directory — becomes a zip. */
  private stageZip(listing: Listing, names: string[]): Transfer {
    const entries: ZipEntry[] = [];
    let gathered = 0;
    const addDir = (rel: string, abs: string) => {
      for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
        const childRel = `${rel}/${dirent.name}`;
        const childAbs = path.join(abs, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ name: `${childRel}/`, data: Buffer.alloc(0), mtimeMs: Date.now() });
          addDir(childRel, childAbs);
        } else if (dirent.isFile()) {
          addFile(childRel, childAbs);
        }
        // Links are skipped like in the listing: a name may not point outside.
      }
    };
    const addFile = (rel: string, abs: string) => {
      let stat: fs.Stats;
      let data: Buffer;
      try {
        stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error('not a file');
        data = fs.readFileSync(abs);
      } catch {
        throw Object.assign(new Error(`unreadable file: ${rel}`), { code: 'fs_not_found' });
      }
      gathered += stat.size;
      if (gathered > ZIP_INPUT_MAX_BYTES) {
        throw Object.assign(new Error(`selection exceeds ${ZIP_INPUT_MAX_BYTES} bytes`), {
          code: 'fs_too_large',
        });
      }
      entries.push({ name: rel, data, mtimeMs: stat.mtimeMs });
    };
    for (const name of names) {
      const abs = path.join(listing.dir, name);
      if (listing.entries.get(name) === 'dir') {
        entries.push({ name: `${name}/`, data: Buffer.alloc(0), mtimeMs: Date.now() });
        addDir(name, abs);
      } else {
        addFile(name, abs);
      }
    }
    const archive = buildZipArchive(entries);
    if (archive.length > FS_DOWNLOAD_MAX_BYTES) {
      throw Object.assign(new Error(`archive exceeds ${FS_DOWNLOAD_MAX_BYTES} bytes`), {
        code: 'fs_too_large',
      });
    }
    ensureDir(this.downloadsDir);
    const filePath = path.join(this.downloadsDir, `${crypto.randomUUID()}.zip`);
    fs.writeFileSync(filePath, archive, { mode: 0o600 });
    const base = sanitizePasteFileName(path.basename(listing.dir)) || 'files';
    return {
      filePath,
      name: `${base}.zip`,
      size: archive.length,
      totalChunks: Math.max(1, Math.ceil(archive.length / FS_DOWNLOAD_CHUNK_BYTES)),
      fd: null,
      temporary: true,
      touchedAtMs: Date.now(),
    };
  }

  /** `fs_download_chunk_request`: one slice of a staged transfer. */
  sendChunk(streamId: string | null, requestId: string, index: unknown): void {
    const key = `${streamId} ${requestId}`;
    const transfer = this.transfers.get(key);
    if (!transfer || !Number.isInteger(index)) return;
    const slice = index as number;
    if (slice < 0 || slice >= transfer.totalChunks) return;
    transfer.touchedAtMs = Date.now();
    try {
      if (transfer.fd === null) transfer.fd = fs.openSync(transfer.filePath, 'r');
      const offset = slice * FS_DOWNLOAD_CHUNK_BYTES;
      const length = Math.min(FS_DOWNLOAD_CHUNK_BYTES, transfer.size - offset);
      const buffer = Buffer.alloc(length);
      fs.readSync(transfer.fd, buffer, 0, length, offset);
      this.send({
        type: 'fs_download_chunk',
        clientId: streamId,
        requestId,
        index: slice,
        dataBase64: buffer.toString('base64'),
      });
    } catch (error) {
      this.fail(streamId, requestId, 'fs_download_failed', (error as Error).message);
    }
    if (slice === transfer.totalChunks - 1) this.closeTransfer(key);
  }

  private closeTransfer(key: string): void {
    const transfer = this.transfers.get(key);
    if (!transfer) return;
    this.transfers.delete(key);
    if (transfer.fd !== null) {
      try {
        fs.closeSync(transfer.fd);
      } catch {
        // Already gone; the file is closed or never was.
      }
    }
    if (transfer.temporary) {
      try {
        fs.rmSync(transfer.filePath, { force: true });
      } catch {
        // A leftover zip is swept the next time the connector starts.
      }
    }
  }

  /** Every staged transfer and listing, gone: connector stopping or relay lost. */
  stopAll(): void {
    for (const key of [...this.transfers.keys()]) this.closeTransfer(key);
    this.listings.clear();
  }
}
