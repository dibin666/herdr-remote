/**
 * One question for Herdr's local socket API.
 *
 * Everything else in this package talks to Herdr by spawning a client into a
 * PTY and shipping the bytes. That is the terminal. This is the side channel:
 * the one place that asks Herdr *about* itself rather than drawing it, so a
 * phone can answer "does anything need me?" without navigating a TUI through a
 * 40-column viewport.
 *
 * The wire format is newline-delimited JSON over the Unix socket:
 *
 *   request   {"id":"…","method":"session.snapshot","params":{}}
 *   response  {"id":"…","result":{…}}  or  {"id":"…","error":{"code","message"}}
 *
 * One request per connection, which is why this is a function and not a client.
 * Herdr closes the socket once it has answered: against 0.9.1 a second request
 * written to the same connection meets `EPIPE`. A long-lived client that
 * reconnects on close therefore turns into a connect-answer-close loop about
 * once a second, busy regardless of how rarely it actually asks anything. The
 * `herdr` CLI connects per command for the same reason, and so does this.
 *
 * Subscriptions are the exception Herdr does keep open — `events.subscribe`
 * holds the connection. Focus and agent-detection events let the caller refresh
 * the focused pane immediately, with a slow poll retained as a fallback.
 *
 * Nothing here may affect a terminal session. Herdr's server is an ordinary
 * process that can be restarted under a running herdr-remote, and when it is,
 * the PTYs keep streaming while this quietly fails and is asked again later.
 */

import net from 'node:net';

/** How long one question waits, connection included. */
const REQUEST_TIMEOUT_MS = 10_000;

/** An answer this long is not an answer. Guards a socket that never newlines. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A subscription that disappears should recover without keeping a dead socket busy. */
const SUBSCRIBE_RETRY_BASE_MS = 1_000;
const SUBSCRIBE_RETRY_MAX_MS = 10_000;

let requestCounter = 0;

type Connect = (path: string) => net.Socket;

/** An event from `events.subscribe`. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HerdrSubscription {
  close(): void;
}

/**
 * Ask Herdr one thing.
 *
 * Resolves with the `result` object, rejects for a refused connection, a
 * timeout, an unparseable answer, or an `error` response — in which case
 * `error.code` is Herdr's own code.
 */
function requestHerdr<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { timeout?: number; connect?: Connect } = {},
): Promise<T> {
  const { timeout = REQUEST_TIMEOUT_MS, connect = net.connect as Connect } = options;
  requestCounter += 1;
  const id = `herdr-remote:${requestCounter}`;

  return new Promise<T>((resolve, reject) => {
    let socket: net.Socket | undefined;
    let buffer = '';
    let settled = false;

    const finish = (error: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      if (error) reject(error);
      else resolve(result as T);
    };

    const timer = setTimeout(
      () => finish(new Error(`Herdr API did not answer ${method} in time`)),
      timeout,
    );
    if (typeof timer.unref === 'function') timer.unref();

    try {
      socket = connect(socketPath);
    } catch (error) {
      finish(error as Error);
      return;
    }

    const connection = socket;
    connection.setEncoding('utf8');
    connection.on('connect', () => {
      connection.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(new Error('Herdr API sent an oversized response'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let message: { result?: T; error?: { code?: string; message?: string } };
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error('Herdr API sent a line that is not JSON'));
        return;
      }
      if (message.error) {
        const error = Object.assign(
          new Error(message.error.message || 'Herdr API request failed'),
          {
            code: message.error.code || 'herdr_api_error',
          },
        );
        finish(error);
        return;
      }
      finish(null, message.result);
    });
    connection.on('error', (error) => finish(error));
    // Herdr hanging up before it answered is the ordinary shape of "the server
    // is not running", not something that needs its own diagnosis.
    connection.on('close', () => finish(new Error(`Herdr API closed before answering ${method}`)));
  });
}

/**
 * Subscribe to Herdr's event stream and reconnect if its local server restarts.
 *
 * The initial response is an acknowledgement (`result.type` is
 * `subscription_started`); later lines are envelopes with `event` and `data`.
 * They share a socket, but are separate NDJSON messages. A subscription never
 * starts or writes to a terminal, so an unavailable socket is only a reason to
 * retry this side channel.
 */
function subscribeHerdr(
  socketPath: string,
  subscriptions: { type: string }[],
  onEvent: (event: HerdrEvent) => void,
  options: { connect?: Connect; retryBaseMs?: number; retryMaxMs?: number } = {},
): HerdrSubscription {
  const {
    connect = net.connect as Connect,
    retryBaseMs = SUBSCRIBE_RETRY_BASE_MS,
    retryMaxMs = SUBSCRIBE_RETRY_MAX_MS,
  } = options;
  let socket: net.Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let retryCount = 0;
  let closed = false;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(retryBaseMs * 2 ** retryCount, retryMaxMs);
    retryCount += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  };

  const open = (): void => {
    if (closed) return;
    let current: net.Socket;
    try {
      current = connect(socketPath);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    let buffer = '';
    let requestId: string | null = null;
    let acknowledged = false;
    const clearHandshake = () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };

    current.setEncoding('utf8');
    current.on('connect', () => {
      requestCounter += 1;
      requestId = `herdr-remote:subscription:${requestCounter}`;
      current.write(
        `${JSON.stringify({
          id: requestId,
          method: 'events.subscribe',
          params: { subscriptions },
        })}\n`,
      );
      handshakeTimer = setTimeout(() => current.destroy(), REQUEST_TIMEOUT_MS);
      if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref();
    });
    current.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        current.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      for (; newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; error?: unknown; event?: unknown; data?: unknown } | null;
        try {
          message = JSON.parse(line);
        } catch {
          current.destroy();
          return;
        }
        if (message?.id === requestId) {
          clearHandshake();
          if (message.error) {
            current.destroy();
            return;
          }
          acknowledged = true;
          retryCount = 0;
        } else if (
          acknowledged &&
          typeof message?.event === 'string' &&
          message.data &&
          typeof message.data === 'object'
        ) {
          try {
            onEvent(message as HerdrEvent);
          } catch {}
        }
      }
    });
    current.on('error', () => {});
    current.on('close', () => {
      clearHandshake();
      if (socket === current) socket = null;
      scheduleReconnect();
    });
  };

  open();
  return {
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      reconnectTimer = null;
      handshakeTimer = null;
      const active = socket;
      socket = null;
      if (active) active.destroy();
    },
  };
}

export { REQUEST_TIMEOUT_MS, requestHerdr, subscribeHerdr };
