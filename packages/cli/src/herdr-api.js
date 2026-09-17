'use strict';

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
 * holds the connection — but they are no use here: the event that tracks agent
 * state is scoped to a single `pane_id`, and the whole-session pane events stay
 * silent through minutes of continuous agent work. The caller polls.
 *
 * Nothing here may affect a terminal session. Herdr's server is an ordinary
 * process that can be restarted under a running herdr-remote, and when it is,
 * the PTYs keep streaming while this quietly fails and is asked again later.
 */

const net = require('node:net');

/** How long one question waits, connection included. */
const REQUEST_TIMEOUT_MS = 10_000;

/** An answer this long is not an answer. Guards a socket that never newlines. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

let requestCounter = 0;

/**
 * Ask Herdr one thing.
 *
 * Resolves with the `result` object, rejects for a refused connection, a
 * timeout, an unparseable answer, or an `error` response — in which case
 * `error.code` is Herdr's own code.
 */
function requestHerdr(socketPath, method, params = {}, options = {}) {
  const { timeout = REQUEST_TIMEOUT_MS, connect = net.connect } = options;
  requestCounter += 1;
  const id = `herdr-remote:${requestCounter}`;

  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(
      () => finish(new Error(`Herdr API did not answer ${method} in time`)),
      timeout,
    );
    if (typeof timer.unref === 'function') timer.unref();

    try {
      socket = connect(socketPath);
    } catch (error) {
      finish(error);
      return;
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(new Error('Herdr API sent an oversized response'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error('Herdr API sent a line that is not JSON'));
        return;
      }
      if (message.error) {
        const error = new Error(message.error.message || 'Herdr API request failed');
        error.code = message.error.code || 'herdr_api_error';
        finish(error);
        return;
      }
      finish(null, message.result);
    });
    socket.on('error', (error) => finish(error));
    // Herdr hanging up before it answered is the ordinary shape of "the server
    // is not running", not something that needs its own diagnosis.
    socket.on('close', () => finish(new Error(`Herdr API closed before answering ${method}`)));
  });
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  requestHerdr,
};
