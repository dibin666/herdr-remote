// What the tool stand-ins of `tool-forward.ts` share: ask the connector over
// its socket, and run the command the stand-in stands in for when nobody
// takes the request.

import { spawnSync } from 'node:child_process';
import type net from 'node:net';
import path from 'node:path';
import { findOnSearchPath } from '../herdr-command.js';
import { TOOL_SOCKET_ENV, TOOL_STREAM_ENV } from './tool-forward.js';

export interface ShimReply {
  ok: boolean;
  /** A clipboard read's answer text; the other requests carry none. */
  text?: string;
}

export type Connect = (path: string) => net.Socket;
export type Run = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
) => number;

/**
 * Send `payload` to the connector and parse its one-line answer; `null` when
 * it cannot be reached or does not answer in time, which always means: run
 * the real command.
 */
export function request(
  socketPath: string,
  payload: unknown,
  timeoutMs: number,
  connect: Connect,
): Promise<ShimReply | null> {
  return new Promise((resolve) => {
    let reply = '';
    const socket = connect(socketPath);
    const finish = (answer: ShimReply | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      reply += chunk;
      if (!reply.includes('\n')) return;
      try {
        finish(JSON.parse(reply) as ShimReply);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): number {
  const result = spawnSync(command, args, {
    // A clipboard write the connector did not take still carries its text to
    // the real tool's stdin; every other fallback inherits the streams as-is.
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    env,
    input,
  });
  return result.status ?? 1;
}

/** Run the command the stand-in at `shim` stands in for, from the rest of PATH. */
export function runReal(
  shim: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  run: Run,
  input?: string,
): number {
  const shimDir = path.resolve(path.dirname(shim));
  const rest = String(env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== shimDir)
    .join(path.delimiter);
  const name = path.basename(shim);
  const real = findOnSearchPath(rest, [name]);
  if (!real) {
    process.stderr.write(`herdr-remote: ${name} was not found on PATH\n`);
    return 127;
  }
  // Without the stand-ins or the stream, whatever the real command starts
  // works on this workstation the ordinary way.
  const next: NodeJS.ProcessEnv = { ...env, PATH: rest };
  delete next[TOOL_STREAM_ENV];
  delete next[TOOL_SOCKET_ENV];
  return run(real, args, next, input);
}
