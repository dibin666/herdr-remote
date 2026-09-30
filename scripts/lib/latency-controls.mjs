import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_LATENCY_MS = 5_000;
const DRAIN_TIMEOUT_MS = 16_000;
const POLL_INTERVAL_MS = 10;

/** Test-only HTTP routes around the existing relay, never installed by the production entrypoint. */
export function installLatencyControls(relay, getPairUrl, { terminalMode = 'simulated' } = {}) {
  const original = relay.server.listeners('request');
  for (const listener of original) relay.server.off('request', listener);
  let changing = false;
  const reply = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  relay.server.on('request', (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/__test__')) {
      for (const listener of original) listener.call(relay.server, req, res);
      return;
    }
    if (req.headers.origin && req.headers.origin !== url.origin) {
      reply(res, 403, { message: 'Origin denied' });
      return;
    }
    const handle = async () => {
      if (req.method === 'GET' && url.pathname === '/__test__') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(new URL('./latency-panel.html', import.meta.url)));
      } else if (req.method === 'GET' && url.pathname === '/__test__/webui') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': "frame-ancestors 'self'",
        });
        res.end(
          fs.readFileSync(new URL('../../packages/relay/web/dist/index.html', import.meta.url)),
        );
      } else if (req.method === 'GET' && url.pathname === '/__test__/panel.js') {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(new URL('./latency-panel.mjs', import.meta.url)));
      } else if (req.method === 'GET' && url.pathname === '/__test__/state') {
        reply(res, 200, {
          latencyMs: relay.devLatencyMs,
          maxLatencyMs: MAX_LATENCY_MS,
          terminalMode,
        });
      } else if (req.method === 'POST' && url.pathname === '/__test__/pair') {
        const pairing = new URL(await getPairUrl());
        pairing.pathname = '/__test__/webui';
        reply(res, 200, { url: pairing.href });
      } else if (req.method === 'POST' && url.pathname === '/__test__/latency') {
        const raw = url.searchParams.get('ms');
        const latencyMs = Number(raw);
        if (
          raw === null ||
          !/^\d+$/.test(raw) ||
          !Number.isSafeInteger(latencyMs) ||
          latencyMs > MAX_LATENCY_MS
        ) {
          reply(res, 400, { message: `Expected an integer from 0 to ${MAX_LATENCY_MS} ms` });
          return;
        }
        if (changing) {
          reply(res, 409, { message: 'A latency change is already pending' });
          return;
        }
        changing = true;
        try {
          // Switching to zero must not let new frames overtake already-delayed keystrokes.
          const deadline = Date.now() + DRAIN_TIMEOUT_MS;
          while (relay.activeDelayTimers.size > 0) {
            if (Date.now() >= deadline) {
              reply(res, 409, {
                message: 'Pause typing and try again after queued input finishes',
              });
              return;
            }
            await delay(POLL_INTERVAL_MS);
          }
          relay.devLatencyMs = latencyMs;
          relay.devDelayMs = Math.round(latencyMs / 2);
          reply(res, 200, { latencyMs, oneWayMs: relay.devDelayMs });
        } finally {
          changing = false;
        }
      } else {
        reply(res, 404, { message: 'Unknown test route' });
      }
    };
    handle().catch((error) => {
      if (res.headersSent) res.destroy(error);
      else reply(res, 500, { message: error.message });
    });
  });
}
