// `herdr-remote clipboard`: what the `wl-copy`, `wl-paste`, `xclip`, `xsel`,
// `pbcopy` and `pbpaste` stand-ins of `tool-forward.ts` run when a browser
// window's Herdr client reads or writes the clipboard.
//
// A text write goes to the host connector, which sends it to the window's own
// clipboard. A text read asks the connector for that window's clipboard and
// prints the answer. Anything else — another argument shape, a non-text
// target, a connector that is gone or did not take it — runs the real
// command, so the workstation's clipboard still does everything it used to.

import net from 'node:net';
import path from 'node:path';
import { CLIPBOARD_TEXT_MAX_CHARS } from 'herdr-remote-relay/protocol';
import { type Connect, request, type Run, runCommand, runReal } from './shim-runner.js';
import { TOOL_SOCKET_ENV, TOOL_STREAM_ENV } from './tool-forward.js';

/** Clipboard writes feel instant or they never went. */
const WRITE_TIMEOUT_MS = 2_000;
/**
 * Reads wait on a relay round trip and a browser clipboard read; the
 * connector gives up a second sooner, so its answer always arrives first.
 */
const READ_TIMEOUT_MS = 6_000;

const hasFlag = (args: string[], ...names: string[]) => args.some((arg) => names.includes(arg));

/**
 * The value of a `--type`/`--type=T` argument, or null when absent. The
 * clipboard tools only forward text; any other declared target is for the
 * real command (image paste bridging stays on the workstation's clipboard).
 */
function typeArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--type' || args[i] === '-t') && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith('--type=')) return args[i].slice('--type='.length);
  }
  return null;
}

const isTextTarget = (target: string | null) =>
  target === null || target.startsWith('text/') || target === 'UTF8_STRING' || target === 'STRING';

/**
 * What the invocation means, or null to run the real command. Only shapes the
 * forward path understands are claimed; primary/secondary selections, image
 * targets and service modes all keep acting on the workstation's clipboard.
 */
export function clipboardOp(tool: string, args: string[]): 'read' | 'write' | 'clear' | null {
  switch (tool) {
    case 'pbcopy':
      return 'write';
    case 'pbpaste':
      return 'read';
    case 'wl-copy':
      if (hasFlag(args, '-p', '--primary')) return null;
      if (hasFlag(args, '-c', '--clear')) return 'clear';
      return isTextTarget(typeArg(args)) ? 'write' : null;
    case 'wl-paste':
      if (hasFlag(args, '-p', '--primary')) return null;
      if (hasFlag(args, '-l', '--list-types') || hasFlag(args, '-w', '--watch')) return null;
      return isTextTarget(typeArg(args)) ? 'read' : null;
    case 'xclip': {
      const at = args.findIndex((arg) => arg === '-selection' || arg === '--selection');
      const selection = at >= 0 && at + 1 < args.length ? args[at + 1] : null;
      // No selection flag means xclip's default `primary`, which is not the
      // browser's clipboard either way.
      if (selection !== 'clipboard' && selection !== 'clip') return null;
      if (hasFlag(args, '-out', '-o', '--out')) return 'read';
      if (hasFlag(args, '-in', '-i', '--in')) return 'write';
      return null;
    }
    case 'xsel': {
      if (!hasFlag(args, '-b', '--clipboard')) return null;
      if (hasFlag(args, '-o', '--output')) return 'read';
      if (hasFlag(args, '-i', '--input')) return 'write';
      if (hasFlag(args, '-d', '--delete')) return 'clear';
      return null;
    }
    default:
      return null;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk;
  return data;
}

export async function runClipboardShim(
  argv: string[],
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    connect = net.connect as Connect,
    run = runCommand,
  }: {
    env?: NodeJS.ProcessEnv;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    connect?: Connect;
    run?: Run;
  } = {},
): Promise<number> {
  const [shim, ...args] = argv;
  if (!shim) return 2;
  const op = clipboardOp(path.basename(shim), args);
  if (!op) return runReal(shim, args, env, run);
  const stream = env[TOOL_STREAM_ENV];
  const socketPath = env[TOOL_SOCKET_ENV];
  if (op === 'write' || op === 'clear') {
    const text = op === 'clear' ? '' : await readAll(stdin);
    if (stream && socketPath && text.length <= CLIPBOARD_TEXT_MAX_CHARS) {
      const reply = await request(
        socketPath,
        { stream, kind: 'clipboard_write', text },
        WRITE_TIMEOUT_MS,
        connect,
      );
      if (reply?.ok) return 0;
    }
    // The write still belongs on this workstation's clipboard then — with its
    // stdin, which the real command can no longer read itself.
    return runReal(shim, args, env, run, text);
  }
  if (stream && socketPath) {
    const reply = await request(
      socketPath,
      { stream, kind: 'clipboard_read' },
      READ_TIMEOUT_MS,
      connect,
    );
    if (reply?.ok && typeof reply.text === 'string') {
      stdout.write(reply.text);
      return 0;
    }
  }
  return runReal(shim, args, env, run);
}
