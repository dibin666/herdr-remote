import os from 'node:os';
import pty, { type IPty } from 'node-pty';

interface PtySessionOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  socketPath?: string | null;
}

interface PtyStartOptions {
  cols?: number;
  rows?: number;
  onData?: (data: string) => void;
  onExit?: (event: { exitCode: number; signal?: number }) => void;
}

class PtySession {
  static DEFAULT_COLS = 100;
  static DEFAULT_ROWS = 30;
  static MIN_DIMENSION = 2;
  static MAX_DIMENSION = 500;

  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly socketPath: string | null | undefined;
  terminal: IPty | null;
  startedAt: string | null;

  constructor({ command, args = [], cwd = os.homedir(), socketPath }: PtySessionOptions = {}) {
    if (typeof command !== 'string' || command.length === 0)
      throw new TypeError('command must be a non-empty string');
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
      throw new TypeError('args must be strings');
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.socketPath = socketPath;
    this.terminal = null;
    this.startedAt = null;
  }

  static childEnv(socketPath: string | null | undefined): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('HERDR_')) delete env[key];
    }
    if (socketPath) env.HERDR_SOCKET_PATH = socketPath;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    return env;
  }

  static clampDimension(value: unknown, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return fallback;
    return Math.min(PtySession.MAX_DIMENSION, Math.max(PtySession.MIN_DIMENSION, numeric));
  }

  start({ cols, rows, onData, onExit }: PtyStartOptions): this {
    if (this.terminal) throw new Error('PTY session already started');
    this.terminal = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols: PtySession.clampDimension(cols, PtySession.DEFAULT_COLS),
      rows: PtySession.clampDimension(rows, PtySession.DEFAULT_ROWS),
      cwd: this.cwd,
      env: PtySession.childEnv(this.socketPath) as Record<string, string>,
    });
    this.startedAt = new Date().toISOString();
    const terminal = this.terminal;
    if (onData) terminal.onData(onData);
    if (onExit) {
      terminal.onExit((event) => {
        this.terminal = null;
        onExit(event);
      });
    }
    return this;
  }

  write(data: Buffer | string): void {
    if (!this.terminal) return;
    this.terminal.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  }

  resize(cols: unknown, rows: unknown): void {
    if (!this.terminal) return;
    this.terminal.resize(
      PtySession.clampDimension(cols, PtySession.DEFAULT_COLS),
      PtySession.clampDimension(rows, PtySession.DEFAULT_ROWS),
    );
  }

  info(): {
    pid: number | null;
    command: string;
    cols: number | null;
    rows: number | null;
    cwd: string;
    createdAt: string | null;
  } {
    return {
      pid: this.terminal?.pid || null,
      command: this.command,
      cols: this.terminal?.cols || null,
      rows: this.terminal?.rows || null,
      cwd: this.cwd,
      createdAt: this.startedAt,
    };
  }

  kill(): void {
    try {
      this.terminal?.kill();
    } catch {
      // The process has already exited.
    }
    this.terminal = null;
  }
}

export { PtySession };
