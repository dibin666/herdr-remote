// Shared by the relay tests: a relay config sized for tests, and the
// WebSocket and HTTP calls a test client makes.
import http from 'node:http';
import { WebSocket } from 'ws';

/**
 * Long enough for a busy CI machine running every package's tests at once;
 * a message that is coming arrives in milliseconds.
 */
const MESSAGE_TIMEOUT_MS = 5000;

export function relayConfig({
  maxPayloadBytes = 1024 * 1024,
  maxBufferedBytesPerClient = 1024,
} = {}) {
  return {
    relay: {
      local: true,
      url: 'ws://127.0.0.1:0',
      publicUrl: 'http://127.0.0.1:0',
      host: '127.0.0.1',
      port: 0,
      maxPayloadBytes,
      maxClientsPerHost: 8,
      maxHosts: 8,
      maxBufferedBytesPerClient,
      hostReconnectGraceMs: 500,
    },
    auth: { pairingTtlMs: 60_000, deviceTtlMs: 60_000, maxDevices: 8 },
    cleanup: { intervalMs: 60_000, heartbeatIntervalMs: 60_000, staleAfterMs: 180_000 },
  };
}

export function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * The next frame `predicate` accepts, as `{ value, isBinary }`: text frames
 * are parsed as JSON when they can be, binary frames are passed as they are.
 */
export function nextMessage(ws, predicate = () => true, timeoutMs = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      let value = data;
      if (!isBinary) {
        try {
          value = JSON.parse(data.toString());
        } catch {
          // Not JSON: the predicate sees the raw frame.
        }
      }
      if (!predicate(value, isBinary)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ value, isBinary });
    };
    ws.on('message', onMessage);
  });
}

/** The next JSON control message `predicate` accepts, as the parsed object. */
export async function nextJson(ws, predicate = () => true, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const { value } = await nextMessage(
    ws,
    (candidate, isBinary) => !isBinary && typeof candidate === 'object' && predicate(candidate),
    timeoutMs,
  );
  return value;
}

/** POSTs with no body; resolves the JSON reply, rejects on an HTTP error. */
export function postJson(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(urlString, { method: 'POST', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          return reject(error);
        }
        if (response.statusCode >= 400)
          return reject(new Error(body.message || `HTTP ${response.statusCode}`));
        resolve(body);
      });
    });
    request.on('error', reject);
    request.end();
  });
}
