// `herdr-remote open-link`: what the `xdg-open` and `open` stand-ins of
// `tool-forward.ts` run when a browser window's Herdr client opens a link.
//
// A lone web link goes to the host connector, which sends it to the window
// that clicked it. Anything else — another argument shape, a client outside a
// browser window, a connector that is gone or did not take it — runs the real
// command, so nothing that used to open on the workstation stops opening.

import net from 'node:net';
import { sanitizeOpenLinkUrl } from 'herdr-remote-relay/protocol';
import { type Connect, request, type Run, runCommand, runReal } from './shim-runner.js';
import { TOOL_SOCKET_ENV, TOOL_STREAM_ENV } from './tool-forward.js';

/** Long enough for a busy connector, short enough that a click still feels like one. */
const FORWARD_TIMEOUT_MS = 2_000;

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
  const stream = env[TOOL_STREAM_ENV];
  const socketPath = env[TOOL_SOCKET_ENV];
  const url = args.length === 1 ? sanitizeOpenLinkUrl(args[0]) : null;
  if (url && stream && socketPath) {
    const reply = await request(
      socketPath,
      { stream, kind: 'link', url },
      FORWARD_TIMEOUT_MS,
      connect,
    );
    if (reply?.ok) return 0;
  }
  return runReal(shim, args, env, run);
}
