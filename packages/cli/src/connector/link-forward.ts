// Links a browser window clicks in Herdr, opened in that browser.
//
// Herdr opens a Ctrl-clicked web link from the client that saw the click, by
// running `xdg-open` (Linux) or `open` (macOS) from its PATH. A browser
// window's client runs here on the workstation, so the link used to open on
// the workstation's desktop, out of sight of the phone that clicked it. Each
// window's client therefore gets a PATH that finds stand-ins for those two
// commands first. A stand-in hands a web link and its window's stream to the
// listener here, which passes it to the relay; anything else, or a link
// nobody can take, goes to the real command (see `link-shim.ts`).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CAPABILITY, sanitizeOpenLinkUrl } from 'herdr-remote-relay/protocol';
import { cliEntryPoint } from '../keepalive/environment.js';

/** The window a Herdr client belongs to, as its stand-ins see it. */
export const LINK_STREAM_ENV = 'HERDR_REMOTE_LINK_STREAM';
/** Where the stand-ins reach this listener. */
export const LINK_SOCKET_ENV = 'HERDR_REMOTE_LINK_SOCKET';
/** What Herdr runs to open a link: `xdg-open` on Linux, `open` on macOS. */
const OPENERS = ['xdg-open', 'open'];
/** A request is one link and a stream id; anything this long is not one. */
const MAX_REQUEST_BYTES = 16 * 1_024;

export interface LinkForwardOptions {
  /** The state directory: the stand-ins and the socket live under it. */
  directory: string;
  node?: string;
  entry?: string;
  platform?: NodeJS.Platform;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A stand-in that runs `herdr-remote open-link <itself> <args…>`. */
export function shimScript(node: string, entry: string): string {
  return `#!/bin/sh\nexec ${posixQuote(node)} ${posixQuote(entry)} open-link "$0" "$@"\n`;
}

export class LinkForward {
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

  constructor(
    {
      directory,
      node = process.execPath,
      entry = cliEntryPoint(),
      platform = process.platform,
    }: LinkForwardOptions,
    send: (payload: unknown) => void,
    hasStream: (streamId: string) => boolean,
  ) {
    this.shimDir = path.join(directory, 'link-shims');
    this.socketPath = path.join(directory, 'links.sock');
    this.send = send;
    this.hasStream = hasStream;
    this.node = node;
    this.entry = entry;
    // Herdr on Windows opens links through the shell, not a command on PATH.
    this.supported = platform !== 'win32';
  }

  /**
   * What the relay just said it can do, from its `host_ready`; `undefined`
   * once the connection is gone. Windows started while it cannot take links
   * keep opening them on this workstation.
   */
  setRelayCapabilities(capabilities: unknown): void {
    this.relayOpensLinks =
      Array.isArray(capabilities) && capabilities.includes(CAPABILITY.openLink);
    if (this.relayOpensLinks) this.start();
  }

  /** Write the stand-ins and listen for them; idempotent. */
  private start(): void {
    if (!this.supported || this.server) return;
    try {
      fs.mkdirSync(this.shimDir, { recursive: true, mode: 0o700 });
      const script = shimScript(this.node, this.entry);
      for (const name of OPENERS) {
        fs.writeFileSync(path.join(this.shimDir, name), script, { mode: 0o755 });
      }
      // The connector holds the host lock, so a socket left here is a dead one's.
      fs.rmSync(this.socketPath, { force: true });
    } catch (error) {
      process.stderr.write(
        `herdr-remote host connector: links will open on this workstation: ${(error as Error).message}\n`,
      );
      return;
    }
    const server = net.createServer((socket) => this.serve(socket));
    server.on('error', (error) => {
      process.stderr.write(
        `herdr-remote host connector: links will open on this workstation: ${error.message}\n`,
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
  }

  /**
   * What a window's Herdr client needs to send its links back to it. Empty
   * when nothing here would take them, so that client opens links the way it
   * always has. A stand-in that cannot reach the listener does the same.
   */
  env(streamId: string, searchPath = process.env.PATH || ''): Record<string, string> {
    if (!this.server || !this.relayOpensLinks) return {};
    return {
      PATH: searchPath ? `${this.shimDir}${path.delimiter}${searchPath}` : this.shimDir,
      [LINK_STREAM_ENV]: streamId,
      [LINK_SOCKET_ENV]: this.socketPath,
    };
  }

  private serve(socket: net.Socket): void {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // The stand-in gave up waiting; it opens the link itself.
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end < 0 && buffered.length <= MAX_REQUEST_BYTES) return;
      socket.removeAllListeners('data');
      socket.end(`${JSON.stringify({ ok: end >= 0 && this.handle(buffered.slice(0, end)) })}\n`);
    });
  }

  private handle(line: string): boolean {
    let request: { stream?: unknown; url?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      return false;
    }
    const url = sanitizeOpenLinkUrl(request.url);
    const stream = request.stream;
    if (!url || typeof stream !== 'string' || !this.relayOpensLinks) return false;
    if (!this.hasStream(stream)) return false;
    this.send({ type: 'open_link', clientId: stream, url });
    return true;
  }
}
