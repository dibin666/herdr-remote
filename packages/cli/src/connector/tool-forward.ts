// Tools a browser window's terminal session runs, handled in that window.
//
// Herdr opens a Ctrl-clicked web link by running `xdg-open` (Linux) or `open`
// (macOS) from its PATH, and moves text in and out of the clipboard through
// `wl-copy`, `wl-paste`, `xclip`, `xsel` or `pbcopy`/`pbpaste` — commands that
// act on the workstation, out of reach of the browser the window runs in. Each
// window's Herdr client therefore gets a PATH whose first entry holds
// stand-ins for those commands. A stand-in hands the request and its window's
// stream to the listener here; the listener passes it to the relay, and for a
// clipboard read holds the socket until that window answers. Anything else —
// a request nobody can take, a flag the stand-in does not forward — runs the
// real command (see `link-shim.ts` and `clipboard-shim.ts`), so the
// workstation keeps doing what it always did.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  CAPABILITY,
  CLIPBOARD_TEXT_MAX_CHARS,
  sanitizeClipboardText,
  sanitizeOpenLinkUrl,
} from 'herdr-remote-relay/protocol';
import { randomToken } from 'herdr-remote-relay/state';
import { cliEntryPoint } from '../keepalive/environment.js';

/** The window a Herdr client belongs to, as its stand-ins see it. */
export const TOOL_STREAM_ENV = 'HERDR_REMOTE_TOOL_STREAM';
/** Where the stand-ins reach this listener. */
export const TOOL_SOCKET_ENV = 'HERDR_REMOTE_TOOL_SOCKET';
/** What Herdr runs to open a link: `xdg-open` on Linux, `open` on macOS. */
const OPENERS = ['xdg-open', 'open'];
/** The clipboard commands each window's Herdr client is offered instead. */
const CLIPBOARD_TOOLS = ['wl-copy', 'wl-paste', 'xclip', 'xsel', 'pbcopy', 'pbpaste'];
/**
 * A request is one link, or one clipboard payload plus JSON envelope; past
 * this it is not one either way.
 */
const MAX_REQUEST_BYTES = CLIPBOARD_TEXT_MAX_CHARS + 256 * 1_024;
/**
 * How long a clipboard read waits for its window's answer before the stand-in
 * falls back to the real tool. Covers a relay round trip and the browser's
 * clipboard read; anything slower means nobody is answering.
 */
const CLIPBOARD_READ_REPLY_MS = 5_000;

export interface ToolForwardOptions {
  /** The state directory: the stand-ins and the socket live under it. */
  directory: string;
  node?: string;
  entry?: string;
  platform?: NodeJS.Platform;
}

interface PendingRead {
  resolve: (reply: { ok: boolean; text?: string }) => void;
  timer: NodeJS.Timeout;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A stand-in that runs `herdr-remote <command> <itself> <args…>`. */
export function shimScript(node: string, entry: string, command: string): string {
  return `#!/bin/sh\nexec ${posixQuote(node)} ${posixQuote(entry)} ${posixQuote(command)} "$0" "$@"\n`;
}

export class ToolForward {
  readonly shimDir: string;
  readonly socketPath: string;
  private readonly send: (payload: unknown) => void;
  private readonly hasStream: (streamId: string) => boolean;
  private readonly node: string;
  private readonly entry: string;
  private readonly supported: boolean;
  private server: net.Server | null = null;
  /** The relay hands a link to the window that clicked it; older ones drop it. */
  private relayOpensLinks = false;
  /** The relay routes clipboard requests to the window that owns the stream. */
  private relayForwardsClipboard = false;
  /** Clipboard reads a window has not answered yet, by their request id. */
  private readonly pendingReads = new Map<string, PendingRead>();

  constructor(
    {
      directory,
      node = process.execPath,
      entry = cliEntryPoint(),
      platform = process.platform,
    }: ToolForwardOptions,
    send: (payload: unknown) => void,
    hasStream: (streamId: string) => boolean,
  ) {
    this.shimDir = path.join(directory, 'tool-shims');
    this.socketPath = path.join(directory, 'tools.sock');
    this.send = send;
    this.hasStream = hasStream;
    this.node = node;
    this.entry = entry;
    // The stand-ins and their unix socket are posix; Windows keeps its own
    // link and clipboard handling.
    this.supported = platform !== 'win32';
  }

  /**
   * What the relay just said it can do, from its `host_ready`; `undefined`
   * once the connection is gone. Windows started while a tool is not taken
   * keep letting it act on this workstation.
   */
  setRelayCapabilities(capabilities: unknown): void {
    const list = Array.isArray(capabilities) ? capabilities : [];
    this.relayOpensLinks = list.includes(CAPABILITY.openLink);
    this.relayForwardsClipboard = list.includes(CAPABILITY.clipboardForward);
    if (this.relayOpensLinks || this.relayForwardsClipboard) this.start();
  }

  /** Write the stand-ins for what the relay takes, and listen; idempotent. */
  private start(): void {
    if (!this.supported) return;
    try {
      fs.mkdirSync(this.shimDir, { recursive: true, mode: 0o700 });
      const tools = new Map<string, string>();
      if (this.relayOpensLinks) for (const name of OPENERS) tools.set(name, 'open-link');
      if (this.relayForwardsClipboard)
        for (const name of CLIPBOARD_TOOLS) tools.set(name, 'clipboard');
      for (const file of fs.readdirSync(this.shimDir)) {
        if (!tools.has(file)) fs.rmSync(path.join(this.shimDir, file), { force: true });
      }
      for (const [name, command] of tools) {
        fs.writeFileSync(
          path.join(this.shimDir, name),
          shimScript(this.node, this.entry, command),
          {
            mode: 0o755,
          },
        );
      }
      // The connector holds the host lock, so a socket left here is a dead one's.
      fs.rmSync(this.socketPath, { force: true });
    } catch (error) {
      process.stderr.write(
        `herdr-remote host connector: links and clipboard will act on this workstation: ${(error as Error).message}\n`,
      );
      return;
    }
    if (this.server) return;
    const server = net.createServer((socket) => this.serve(socket));
    server.on('error', (error) => {
      process.stderr.write(
        `herdr-remote host connector: links and clipboard will act on this workstation: ${error.message}\n`,
      );
      if (this.server === server) this.server = null;
    });
    server.listen(this.socketPath, () => {
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch {
        // The state directory is already private to this account.
      }
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    for (const [, pending] of this.pendingReads) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false });
    }
    this.pendingReads.clear();
  }

  /**
   * What a window's Herdr client needs to send its links and clipboard back
   * to that window. Empty when nothing here would take them, so that client
   * opens links and clips the way it always has. A stand-in that cannot reach
   * the listener does the same.
   */
  env(streamId: string, searchPath = process.env.PATH || ''): Record<string, string> {
    if (!this.server || (!this.relayOpensLinks && !this.relayForwardsClipboard)) return {};
    return {
      PATH: searchPath ? `${this.shimDir}${path.delimiter}${searchPath}` : this.shimDir,
      [TOOL_STREAM_ENV]: streamId,
      [TOOL_SOCKET_ENV]: this.socketPath,
    };
  }

  /**
   * The window's answer to a `clipboard_read`, routed back by request id. A
   * late or repeated answer finds nobody waiting and is dropped.
   */
  resolveClipboardReadReply(requestId: unknown, text: unknown): void {
    if (typeof requestId !== 'string' || typeof text !== 'string') return;
    const pending = this.pendingReads.get(requestId);
    if (!pending) return;
    this.pendingReads.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ ok: true, text });
  }

  private serve(socket: net.Socket): void {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // The stand-in gave up waiting; it runs the real command itself.
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end < 0 && buffered.length <= MAX_REQUEST_BYTES) return;
      socket.removeAllListeners('data');
      void this.reply(socket, end >= 0 ? buffered.slice(0, end) : null);
    });
  }

  /** One request gets one line back, whenever it is ready. */
  private async reply(socket: net.Socket, line: string | null): Promise<void> {
    let answer: { ok: boolean; text?: string } = { ok: false };
    if (line !== null) {
      try {
        answer = await this.handle(line, socket);
      } catch {
        // A request this code cannot answer gets the real command instead.
      }
    }
    try {
      socket.end(`${JSON.stringify(answer)}\n`);
    } catch {
      // The stand-in already left; it runs the real command itself.
    }
  }

  private handle(
    line: string,
    socket: net.Socket,
  ): Promise<{ ok: boolean; text?: string }> | { ok: boolean; text?: string } {
    let request: { stream?: unknown; kind?: unknown; url?: unknown; text?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false };
    }
    const stream = request.stream;
    if (typeof stream !== 'string' || !this.hasStream(stream)) return { ok: false };
    const kind = request.kind;
    if (kind === 'clipboard_write') {
      if (!this.relayForwardsClipboard) return { ok: false };
      const text = sanitizeClipboardText(request.text);
      if (text === null) return { ok: false };
      this.send({ type: 'clipboard_write', clientId: stream, text });
      return { ok: true };
    }
    if (kind === 'clipboard_read') {
      if (!this.relayForwardsClipboard) return { ok: false };
      return this.pendingRead(socket, stream);
    }
    // Anything without a kind is a link; the first stand-ins knew no kinds.
    const url = sanitizeOpenLinkUrl(request.url);
    if (!url || !this.relayOpensLinks) return { ok: false };
    this.send({ type: 'open_link', clientId: stream, url });
    return { ok: true };
  }

  /**
   * Hold the stand-in's socket until its window answers the clipboard read,
   * or until it is clear nobody will: the reply rides the same line the
   * request did, so the promise here resolves into `reply`'s single answer.
   */
  private pendingRead(socket: net.Socket, stream: string): Promise<{ ok: boolean; text?: string }> {
    const requestId = randomToken(24);
    return new Promise((resolve) => {
      const finish = (reply: { ok: boolean; text?: string }) => {
        this.pendingReads.delete(requestId);
        clearTimeout(timer);
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ ok: false }), CLIPBOARD_READ_REPLY_MS);
      this.pendingReads.set(requestId, { resolve, timer });
      socket.once('close', () => {
        // The stand-in hung up; it falls back to the real tool either way.
        if (this.pendingReads.has(requestId)) finish({ ok: false });
      });
      this.send({ type: 'clipboard_read', clientId: stream, requestId });
    });
  }
}
