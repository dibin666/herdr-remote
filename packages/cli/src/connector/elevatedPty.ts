import type net from 'node:net';
import {
  ADMIN_BROKER_MAX_MESSAGE_BYTES,
  connectAdminBroker,
  sendAdminBrokerMessage,
} from './adminBrokerEndpoint.js';

const BROKER_CONNECT_TIMEOUT_MS = 5_000;

interface ElevatedPtyOptions {
  command: string;
  args: string[];
  cwd: string;
  socketPath: string | null | undefined;
}

interface ElevatedPtyStartOptions {
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (event: { exitCode: number; signal?: number }) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export class ElevatedPty {
  pid = 0;
  cols: number;
  rows: number;
  private socket: net.Socket | null = null;
  private input = '';
  private connected = false;
  private started = false;
  private finished = false;
  private killed = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  private readyListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private readonly options: ElevatedPtyOptions;

  constructor(options: ElevatedPtyOptions, cols: number, rows: number) {
    this.options = options;
    this.cols = cols;
    this.rows = rows;
  }

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }

  start({ cols, rows, onData, onExit, onReady, onError }: ElevatedPtyStartOptions): void {
    this.cols = cols;
    this.rows = rows;
    this.dataListener = onData;
    this.exitListener = onExit;
    this.readyListener = onReady || null;
    this.errorListener = onError || null;
    let broker: ReturnType<typeof connectAdminBroker>;
    try {
      broker = connectAdminBroker();
    } catch (error) {
      this.fail(error as Error);
      return;
    }
    const { socket, token } = broker;
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(BROKER_CONNECT_TIMEOUT_MS, () => {
      socket.destroy(new Error('Administrator terminal broker connection timed out'));
    });
    socket.on('connect', () => {
      this.connected = true;
      socket.setTimeout(0);
      sendAdminBrokerMessage(socket, {
        type: 'start',
        token,
        ...this.options,
        cols: this.cols,
        rows: this.rows,
      });
    });
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (this.started && !this.finished && !this.killed) {
        this.finished = true;
        this.exitListener?.({ exitCode: 1 });
      }
    });
  }

  write(data: string): void {
    if (this.started && !this.finished && this.socket?.writable) {
      sendAdminBrokerMessage(this.socket, {
        type: 'input',
        dataBase64: Buffer.from(data).toString('base64'),
      });
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.started && this.socket?.writable) {
      sendAdminBrokerMessage(this.socket, { type: 'resize', cols, rows });
    }
  }

  kill(): void {
    this.killed = true;
    this.pid = 0;
    if (!this.socket) return;
    if (this.connected && this.socket.writable) {
      sendAdminBrokerMessage(this.socket, { type: 'kill' });
      this.socket.end();
    } else {
      this.socket.destroy();
    }
  }

  private receive(chunk: string): void {
    this.input += chunk;
    if (Buffer.byteLength(this.input, 'utf8') > ADMIN_BROKER_MAX_MESSAGE_BYTES) {
      this.socket?.destroy(new Error('Administrator terminal broker message exceeded the limit'));
      return;
    }
    while (true) {
      const newline = this.input.indexOf('\n');
      if (newline < 0) return;
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        this.socket?.destroy(new Error('Administrator terminal broker sent invalid JSON'));
        return;
      }
      if (message.type === 'started') {
        this.started = true;
        this.pid = Number(message.pid) || 0;
        this.readyListener?.();
      } else if (message.type === 'data' && typeof message.dataBase64 === 'string') {
        this.dataListener?.(Buffer.from(message.dataBase64, 'base64').toString('utf8'));
      } else if (message.type === 'exit') {
        this.finished = true;
        this.pid = 0;
        this.exitListener?.({
          exitCode: Number(message.exitCode) || 0,
          ...(typeof message.signal === 'number' ? { signal: message.signal } : {}),
        });
        this.socket?.end();
      } else if (message.type === 'error') {
        this.fail(
          new Error(typeof message.message === 'string' ? message.message : 'Admin PTY failed'),
        );
      }
    }
  }

  private fail(error: Error): void {
    if (this.started) {
      if (!this.finished && !this.killed) {
        this.finished = true;
        this.exitListener?.({ exitCode: 1 });
      }
      return;
    }
    if (this.finished || this.killed) return;
    this.finished = true;
    this.errorListener?.(error);
  }
}
