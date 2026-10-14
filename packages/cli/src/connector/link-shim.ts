// `herdr-remote open-link`: what the `xdg-open` and `open` stand-ins of
// `link-forward.ts` run when a browser window's Herdr client opens a link.
//
// A lone web link goes to the host connector, which sends it to the window
// that clicked it. Anything else — another argument shape, a client outside a
// browser window, a connector that is gone or did not take it — runs the real
// command, so nothing that used to open on the workstation stops opening.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { sanitizeOpenLinkUrl } from 'herdr-remote-relay/protocol';
import { findOnSearchPath } from '../herdr-command.js';
import { LINK_SOCKET_ENV, LINK_STREAM_ENV } from './link-forward.js';

/** Long enough for a busy connector, short enough that a click still feels like one. */
const FORWARD_TIMEOUT_MS = 2_000;

type Connect = (path: string) => net.Socket;
type Run = (command: string, args: string[], env: NodeJS.ProcessEnv) => number;

/** Ask the connector to send `url` to `stream`'s window; true once it says it did. */
function forward(socketPath: string, stream: string, url: string, connect: Connect) {
  return new Promise<boolean>((resolve) => {
    let reply = '';
    const socket = connect(socketPath);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), FORWARD_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ stream, url })}\n`));
    socket.on('data', (chunk: string) => {
      reply += chunk;
      if (!reply.includes('\n')) return;
      try {
        finish(JSON.parse(reply).ok === true);
      } catch {
        finish(false);
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  return result.status ?? 1;
}

/** Run the command the stand-in at `shim` stands in for, from the rest of PATH. */
function runReal(shim: string, args: string[], env: NodeJS.ProcessEnv, run: Run): number {
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
  // opens its own links the ordinary way.
  const next: NodeJS.ProcessEnv = { ...env, PATH: rest };
  delete next[LINK_STREAM_ENV];
  delete next[LINK_SOCKET_ENV];
  return run(real, args, next);
}

export async function runLinkShim(
  argv: string[],
  {
    env = process.env,
    connect = net.connect as Connect,
    run = runCommand,
  }: { env?: NodeJS.ProcessEnv; connect?: Connect; run?: Run } = {},
): Promise<number> {
  const [shim, ...args] = argv;
  if (!shim) return 2;
  const stream = env[LINK_STREAM_ENV];
  const socketPath = env[LINK_SOCKET_ENV];
  const url = args.length === 1 ? sanitizeOpenLinkUrl(args[0]) : null;
  if (url && stream && socketPath && (await forward(socketPath, stream, url, connect))) return 0;
  return runReal(shim, args, env, run);
}
