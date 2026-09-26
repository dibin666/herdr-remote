// One Herdr client in a PTY per browser window, and starting Herdr's server
// when a window finds it not running.

import {
  FRAME_TYPE_OUTPUT,
  packStreamFrame,
  packStreamFrameV2,
  type RelayResizeMessage,
  type RelaySessionStartMessage,
} from 'herdr-remote-relay/protocol';
import {
  type HerdrLookup,
  type HerdrVersion,
  herdrNotFoundMessage,
  herdrOutdatedMessage,
  herdrVersion,
  resolveHerdrCommand,
  verifyHerdrCommand,
} from '../herdr-command.js';
import {
  ensureHerdrServer,
  probeHerdrServer,
  type ServerLaunch,
  type ServerProbe,
} from '../herdr-server.js';
import { PtySession } from '../pty-session.js';
import { inspectSocket } from '../socket-discovery.js';
import { streamOf } from './wire.js';

/**
 * A session that dies this fast never really started. Anything longer is a
 * session the user actually used and then left.
 */
const FAST_FAILURE_MS = 1500;
/** How many broken starts in a row before we stop calling them exits. */
export const FAST_FAILURE_LIMIT = 3;

/** A window's session start, as held while Herdr is checked or started. */
type StartRequest = Pick<RelaySessionStartMessage, 'clientId' | 'streamId' | 'streamIndex'> & {
  cols?: number;
  rows?: number;
};

export interface LiveSession {
  id: string;
  /** The v2 frame index the relay assigned, or null for v1 frames. */
  streamIndex: number | null;
  pty: PtySession;
  cols: number;
  rows: number;
  createdAt: string;
  startedAtMs: number;
  /** Output from this tick, sent as one frame on the next. */
  pendingOutput: Buffer[];
  flushImmediate: NodeJS.Immediate | null;
}

/** How sessions reach the relay: through whatever socket the connector has now. */
export interface SessionLink {
  send(payload: unknown): void;
  sendFrame(frame: Buffer): void;
  /** The set of PTYs changed, which the relay's status page shows. */
  changed(): void;
}

export interface SessionsOptions {
  socketPath: string;
  /** Where to look for Herdr when the command has to be resolved again. */
  herdrLookup?: HerdrLookup;
  herdrCommand?: string;
  herdrArgs: string[];
  cwd: string;
  readHerdrVersion?: (options: { command: string }) => HerdrVersion;
  PtySession?: typeof PtySession;
  /** Is Herdr's server answering, and how to start it; injectable for tests. */
  probeHerdr?: (socketPath: string) => Promise<ServerProbe>;
  ensureHerdr?: (launch: ServerLaunch) => Promise<{ started: boolean }>;
  herdrLogPath: string;
}

export class Sessions {
  /** Running sessions by stream id. */
  readonly byStream = new Map<string, LiveSession>();
  /** v2 frame index → stream id. */
  readonly streamIndexToId = new Map<number, string>();
  /** Windows whose session waits on a Herdr that is not running, by stream. */
  readonly waitingForHerdr = new Map<string, StartRequest>();
  /** Session starts between their liveness check and their PTY, by stream. */
  private readonly probingStarts = new Map<string, { message: StartRequest }>();
  /** One start at a time, however many windows asked for it. */
  private herdrLaunch: Promise<{ started: boolean }> | null = null;
  private herdrVersionWarned = false;
  fastFailures = 0;
  herdrCommand: string;
  herdrArgs: string[];
  readonly socketPath: string;
  private readonly cwd: string;
  private readonly herdrLookup: HerdrLookup;
  private readonly herdrLogPath: string;
  private readonly readHerdrVersion: (options: { command: string }) => HerdrVersion;
  private readonly Pty: typeof PtySession;
  private readonly probeHerdr: (socketPath: string) => Promise<ServerProbe>;
  private readonly ensureHerdr: (launch: ServerLaunch) => Promise<{ started: boolean }>;
  private readonly link: SessionLink;

  constructor(options: SessionsOptions, link: SessionLink) {
    this.socketPath = options.socketPath;
    this.herdrLookup = options.herdrLookup || {};
    this.herdrCommand = options.herdrCommand || resolveHerdrCommand(this.herdrLookup);
    this.herdrArgs = options.herdrArgs;
    this.cwd = options.cwd;
    this.herdrLogPath = options.herdrLogPath;
    this.readHerdrVersion = options.readHerdrVersion || herdrVersion;
    this.Pty = options.PtySession || PtySession;
    this.probeHerdr = options.probeHerdr || probeHerdrServer;
    this.ensureHerdr = options.ensureHerdr || ensureHerdrServer;
    this.link = link;
  }

  private sendError(streamId: string, code: string, message: string | undefined): void {
    this.link.send({ type: 'error', clientId: streamId, code, message });
  }

  /**
   * Confirm Herdr is really there before the name reaches `pty.spawn`.
   *
   * node-pty resolves the command with `execvp(3)` inside the forked child, so
   * a missing binary is not a spawn error anyone can catch: the child writes
   * "execvp(3) failed.: No such file or directory" into the PTY and exits. The
   * `session_exit` that follows makes the relay drop the browser's socket, the
   * browser reconnects into the same broken start, and that is the reconnect
   * loop of issue #1. Refusing to start keeps the socket up and puts the actual
   * reason in front of the user.
   *
   * Re-resolved per session rather than cached from the constructor: a service
   * that started before Herdr was installed should pick it up without a restart.
   */
  ensureHerdrCommand(): string | null {
    const resolved = verifyHerdrCommand(this.herdrCommand, this.herdrLookup);
    if (resolved.found) {
      this.herdrCommand = resolved.command;
      this.warnIfHerdrOutdated();
      return null;
    }
    return herdrNotFoundMessage(this.herdrLookup);
  }

  /**
   * Say once that the installed Herdr is older than this release expects.
   *
   * Never a refusal to start. An older Herdr still runs — it just misbehaves in
   * ways a browser window notices — and the comment on `start` explains what a
   * refused start does to a reconnecting browser.
   */
  private warnIfHerdrOutdated(): void {
    if (this.herdrVersionWarned) return;
    const installed = this.readHerdrVersion({ command: this.herdrCommand });
    if (installed.supported) {
      // A version we could not read is checked again on the next session: the
      // install may simply not have been finished writing.
      if (installed.version) this.herdrVersionWarned = true;
      return;
    }
    this.herdrVersionWarned = true;
    process.stderr.write(
      `herdr-remote host connector: ${herdrOutdatedMessage(installed.version as string)}\n`,
    );
  }

  /** Start a window's session, or hold it until Herdr runs. */
  start(message: StartRequest): Promise<void> | undefined {
    const streamId = streamOf(message);
    if (!streamId) return undefined;
    this.stop(streamId);
    const missingHerdr = this.ensureHerdrCommand();
    if (missingHerdr) {
      process.stderr.write(`herdr-remote host connector: ${missingHerdr}\n`);
      this.sendError(streamId, 'herdr_not_found', missingHerdr);
      return undefined;
    }
    const socketInfo = inspectSocket(this.socketPath);
    if (!socketInfo.ok && !socketInfo.missing) {
      this.sendError(streamId, 'herdr_socket_unavailable', socketInfo.reason);
      return undefined;
    }
    if (!socketInfo.ok) {
      this.waitForHerdr(streamId, message);
      return undefined;
    }
    // The socket file alone proves nothing: a `herdr` client pointed at a dead
    // one starts a server of its own, inside this process's service, where the
    // next restart of herdr-remote would kill it. Only a server that accepts a
    // connection gets a client.
    const pending = { message };
    this.probingStarts.set(streamId, pending);
    return this.probeHerdr(this.socketPath).then((probe) => {
      // Stopped, or started again, while the answer was in flight.
      if (this.probingStarts.get(streamId) !== pending) return;
      this.probingStarts.delete(streamId);
      if (probe.state === 'running') this.spawn(pending.message);
      else if (probe.state === 'stopped') this.waitForHerdr(streamId, pending.message);
      else this.sendError(streamId, 'herdr_socket_unavailable', probe.reason);
    });
  }

  /**
   * Hold a window's session until Herdr runs, and ask the browser whether it
   * should be started. Nothing starts until somebody says yes.
   */
  private waitForHerdr(streamId: string, message: StartRequest): void {
    this.waitingForHerdr.set(streamId, message);
    this.sendError(
      streamId,
      'herdr_not_running',
      `Herdr is not running on this workstation (${this.socketPath}).`,
    );
  }

  /**
   * Start this workstation's Herdr server, once, however many windows or
   * callers ask at the same time.
   */
  startHerdr(): Promise<{ started: boolean }> {
    if (!this.herdrLaunch) {
      this.herdrLaunch = Promise.resolve()
        .then(() => {
          const missing = this.ensureHerdrCommand();
          if (missing) throw new Error(missing);
          return this.ensureHerdr({
            command: this.herdrCommand,
            args: this.herdrArgs,
            socketPath: this.socketPath,
            cwd: this.cwd,
            logPath: this.herdrLogPath,
          });
        })
        .finally(() => {
          this.herdrLaunch = null;
        });
    }
    return this.herdrLaunch;
  }

  /**
   * A browser said yes. The relay only ever routes this from a window paired
   * to *this* workstation, so what starts is this user's own Herdr, at the
   * socket this connector is configured for — never one named by the message.
   * Once it runs, every window waiting on it gets its session.
   */
  async startHerdrFor(streamId: string | null): Promise<void> {
    try {
      const result = await this.startHerdr();
      if (result.started)
        process.stderr.write("herdr-remote host connector: started Herdr at a browser's request\n");
    } catch (error) {
      const { message } = error as Error;
      process.stderr.write(`herdr-remote host connector: could not start Herdr: ${message}\n`);
      if (streamId) this.sendError(streamId, 'herdr_start_failed', message);
      return;
    }
    const waiting = [...this.waitingForHerdr.values()];
    this.waitingForHerdr.clear();
    for (const held of waiting) this.spawn(held);
  }

  /** Start the PTY for a window once Herdr is known to be running. */
  private spawn(message: StartRequest): void {
    const streamId = streamOf(message) as string;
    const streamIndex = typeof message.streamIndex === 'number' ? message.streamIndex : null;
    const pty = new this.Pty({
      command: this.herdrCommand,
      args: this.herdrArgs,
      cwd: this.cwd,
      socketPath: this.socketPath,
    });
    const session: LiveSession = {
      id: streamId,
      streamIndex,
      pty,
      cols: Number(message.cols) || PtySession.DEFAULT_COLS,
      rows: Number(message.rows) || PtySession.DEFAULT_ROWS,
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      pendingOutput: [],
      flushImmediate: null,
    };
    const flushOutput = () => {
      if (session.flushImmediate) {
        clearImmediate(session.flushImmediate);
        session.flushImmediate = null;
      }
      if (session.pendingOutput.length === 0) return;
      const payload = Buffer.concat(session.pendingOutput);
      session.pendingOutput = [];
      this.link.sendFrame(
        session.streamIndex !== null
          ? packStreamFrameV2(FRAME_TYPE_OUTPUT, session.streamIndex, payload)
          : packStreamFrame('output', streamId, payload),
      );
    };
    try {
      pty.start({
        cols: session.cols,
        rows: session.rows,
        onData: (data: string | Buffer) => {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
          if (chunk.length === 0) return;
          session.pendingOutput.push(chunk);
          // Coalesce burst output from the same tick into a single frame to reduce
          // packet overhead without introducing timer latency.
          if (!session.flushImmediate) session.flushImmediate = setImmediate(flushOutput);
        },
        onExit: ({ exitCode }) => {
          if (this.byStream.get(streamId) !== session) return;
          this.forget(session);
          this.reportExit(session, exitCode);
          this.link.changed();
        },
      });
    } catch (error) {
      discardOutput(session);
      this.sendError(streamId, 'pty_start_failed', (error as Error).message);
      pty.kill();
      return;
    }
    this.byStream.set(streamId, session);
    if (streamIndex !== null) this.streamIndexToId.set(streamIndex, streamId);
    this.link.send({ type: 'session_ready', clientId: streamId });
    this.link.changed();
  }

  /**
   * Tell the relay how a session ended.
   *
   * `session_exit` is the honest answer for a session that ran, and the relay
   * closes the browser's socket on it so the window can start a fresh one. That
   * is also what turns a start that keeps failing into a reconnect loop: exit,
   * close, reconnect, exit. Once a few starts in a row have died immediately
   * with a non-zero code the failure is systemic, not a session ending, so it is
   * reported as an error — which the relay forwards without dropping the socket,
   * leaving the user with a message instead of a spinner.
   */
  reportExit(session: Pick<LiveSession, 'id' | 'startedAtMs'>, exitCode: number): void {
    const streamId = session.id;
    const lifetimeMs = Date.now() - session.startedAtMs;
    const failedFast = exitCode !== 0 && lifetimeMs < FAST_FAILURE_MS;
    this.fastFailures = failedFast ? this.fastFailures + 1 : 0;
    if (this.fastFailures < FAST_FAILURE_LIMIT) {
      this.link.send({ type: 'session_exit', clientId: streamId, code: exitCode });
      return;
    }
    const message =
      `"${this.herdrCommand}" exited immediately with code ${exitCode} on ${this.fastFailures} attempts in a row. ` +
      'Check that it runs from a terminal, and see the host connector log for what it printed.';
    process.stderr.write(`herdr-remote host connector: ${message}\n`);
    this.sendError(streamId, 'herdr_start_failed', message);
  }

  /** Keyboard input for the session behind a stream id or v2 index. */
  write(stream: { streamId?: string; streamIndex?: number }, payload: Buffer): void {
    const streamId =
      stream.streamIndex !== undefined
        ? this.streamIndexToId.get(stream.streamIndex)
        : stream.streamId;
    if (streamId) this.byStream.get(streamId)?.pty.write(payload);
  }

  resize(message: RelayResizeMessage): void {
    const id = streamOf(message);
    if (!id) return;
    // A window still waiting on Herdr starts at the size it has by then.
    const held = this.waitingForHerdr.get(id) || this.probingStarts.get(id)?.message;
    if (held) {
      if (Number.isInteger(message.cols)) held.cols = message.cols;
      if (Number.isInteger(message.rows)) held.rows = message.rows;
    }
    const session = this.byStream.get(id);
    if (!session) return;
    if (Number.isInteger(message.cols)) session.cols = PtySession.clampDimension(message.cols, 0);
    if (Number.isInteger(message.rows)) session.rows = PtySession.clampDimension(message.rows, 0);
    session.pty.resize(session.cols, session.rows);
  }

  stop(streamId: string): void {
    this.waitingForHerdr.delete(streamId);
    this.probingStarts.delete(streamId);
    const session = this.byStream.get(streamId);
    if (!session) return;
    this.forget(session);
    session.pty.kill();
    this.link.changed();
  }

  stopAll(): void {
    for (const session of this.byStream.values()) {
      discardOutput(session);
      session.pty.kill();
    }
    this.byStream.clear();
    this.streamIndexToId.clear();
    this.waitingForHerdr.clear();
    this.probingStarts.clear();
  }

  /** The running PTYs, as the relay's status page lists them. */
  summaries() {
    return [...this.byStream.values()].map((session) => ({
      id: session.id,
      pid: session.pty.terminal?.pid || null,
      command: session.pty.command,
      cols: session.cols,
      rows: session.rows,
      cwd: session.pty.cwd,
      createdAt: session.createdAt,
      activeClients: 1,
    }));
  }

  private forget(session: LiveSession): void {
    this.byStream.delete(session.id);
    if (session.streamIndex !== null) this.streamIndexToId.delete(session.streamIndex);
    discardOutput(session);
  }
}

function discardOutput(session: LiveSession): void {
  if (session.flushImmediate) {
    clearImmediate(session.flushImmediate);
    session.flushImmediate = null;
  }
  session.pendingOutput = [];
}
