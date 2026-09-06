'use strict';

const os = require('node:os');
const pty = require('node-pty');

class PtySession {
  static DEFAULT_COLS = 100;
  static DEFAULT_ROWS = 30;
  static MIN_DIMENSION = 2;
  static MAX_DIMENSION = 500;

  constructor({ command, args = [], cwd = os.homedir(), socketPath } = {}) {
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be a non-empty string');
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new TypeError('args must be strings');
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.socketPath = socketPath;
    this.terminal = null;
    this.startedAt = null;
  }

  static childEnv(socketPath) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('HERDR_')) delete env[key];
    }
    if (socketPath) env.HERDR_SOCKET_PATH = socketPath;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    return env;
  }

  static clampDimension(value, fallback) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return fallback;
    return Math.min(PtySession.MAX_DIMENSION, Math.max(PtySession.MIN_DIMENSION, numeric));
  }

  start({ cols, rows, onData, onExit }) {
    if (this.terminal) throw new Error('PTY session already started');
    this.terminal = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols: PtySession.clampDimension(cols, PtySession.DEFAULT_COLS),
      rows: PtySession.clampDimension(rows, PtySession.DEFAULT_ROWS),
      cwd: this.cwd,
      env: PtySession.childEnv(this.socketPath),
    });
    this.startedAt = new Date().toISOString();
    if (onData) this.terminal.onData(onData);
    if (onExit) {
      this.terminal.onExit((event) => {
        this.terminal = null;
        onExit(event);
      });
    }
    return this;
  }

  write(data) {
    if (!this.terminal) return;
    this.terminal.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  }

  resize(cols, rows) {
    if (!this.terminal) return;
    this.terminal.resize(
      PtySession.clampDimension(cols, PtySession.DEFAULT_COLS),
      PtySession.clampDimension(rows, PtySession.DEFAULT_ROWS),
    );
  }

  info() {
    return {
      pid: this.terminal?.pid || null,
      command: this.command,
      cols: this.terminal?.cols || null,
      rows: this.terminal?.rows || null,
      cwd: this.cwd,
      createdAt: this.startedAt,
    };
  }

  kill() {
    try {
      this.terminal?.kill();
    } catch {}
    this.terminal = null;
  }
}

module.exports = { PtySession };
