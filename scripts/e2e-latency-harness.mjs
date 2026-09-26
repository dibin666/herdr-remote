#!/usr/bin/env node

/**
 * End-to-end latency validation harness for herdr-remote.
 *
 * Spawns an in-process RelayServer and connects a mock host connector to /ws/host.
 * Simulates a lightweight interactive shell with echo, line editing, and burst throughput testing,
 * allowing full browser UI validation of predictive echo and WebSocket latency optimization.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { handleShellInput } from './lib/fake-shell.mjs';

// The relay's compiled output: `npm run build -w herdr-remote-relay` first.
import { loadRelayConfig } from '../packages/relay/dist/relay-config.js';
import { RelayServer, PROTOCOL_VERSION } from '../packages/relay/dist/relay-server.js';
import {
  packStreamFrame,
  packStreamFrameV2,
  unpackStreamFrame,
  FRAME_TYPE_OUTPUT,
} from '../packages/relay/dist/protocol/index.js';

// 1. Verify frontend web assets exist before starting
const webDistDir = path.resolve(import.meta.dirname, '../packages/relay/web/dist');
const webIndexHtml = path.join(webDistDir, 'index.html');

if (!fs.existsSync(webIndexHtml)) {
  process.stderr.write(
    '\n[e2e-harness] ERROR: Frontend build assets not found.\n' +
      `Expected entrypoint: ${webIndexHtml}\n\n` +
      'Please build the web client first by running:\n' +
      '  npm run build -w herdr-remote-web\n' +
      'or:\n' +
      '  npm run build -w herdr-remote-relay\n\n',
  );
  process.exit(1);
}

// 2. Configure mock host credentials and artificial delay
const HOST_ID = 'mock-host-e2e';
const HOST_TOKEN = 'mock-token-e2e-0123456789abcdef';
const DEFAULT_PORT = 8899;
const TARGET_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT;

const devLatencyRaw = process.env.RELAY_DEV_LATENCY_MS;
const devLatencyMs = devLatencyRaw ? Math.max(0, parseInt(devLatencyRaw, 10) || 0) : 0;

// 3. Isolated temporary directory for relay auth state
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e2e-harness-'));
const stateFile = path.join(tempDir, 'relay-auth.json');

// 4. Session management for the mock shell
const sessions = new Map(); // streamId -> session
const streamIndexToId = new Map(); // streamIndex -> streamId

let relayServer = null;
let hostWs = null;
let heartbeatTimer = null;
let isShuttingDown = false;

/**
 * Send framed output back to the relay for a specific terminal session.
 */
function sendOutput(session, data) {
  if (!hostWs || hostWs.readyState !== WebSocket.OPEN) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (payload.length === 0) return;

  const frame =
    typeof session.streamIndex === 'number'
      ? packStreamFrameV2(FRAME_TYPE_OUTPUT, session.streamIndex, payload)
      : packStreamFrame('output', session.streamId, payload);

  hostWs.send(frame);
}

/**
 * Request a fresh pairing code via the HTTP API.
 */
function requestPairing(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/pair/start',
        method: 'POST',
        headers: {
          'x-herdr-host-id': HOST_ID,
          'x-herdr-host-token': HOST_TOKEN,
          'content-type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode === 200 && data.ok) {
              resolve(data);
            } else {
              reject(new Error(`Pairing API failed (${res.statusCode}): ${data.message || body}`));
            }
          } catch (err) {
            reject(new Error(`Failed to parse pairing response: ${err.message}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

/**
 * Graceful cleanup of resources.
 */
async function cleanup(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  process.stdout.write(`\n[e2e-harness] ${signal || 'Shutting down'} received, cleaning up...\n`);

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (hostWs) {
    try {
      if (hostWs.readyState === WebSocket.OPEN) {
        hostWs.close(1000, 'host_shutdown');
      }
    } catch {
      // Shutting down; a socket that will not close is dropped with the process.
    }
    hostWs = null;
  }

  if (relayServer) {
    try {
      await relayServer.close();
    } catch {
      // Shutting down; the port is released when the process exits.
    }
    relayServer = null;
  }

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // A leftover temp directory is harmless.
  }

  process.stdout.write('[e2e-harness] Cleanup complete.\n');
  process.exit(0);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

async function main() {
  // Build relay configuration
  const { config } = loadRelayConfig({ argv: [], env: process.env });
  config.relay.mode = 'local';
  config.relay.host = '127.0.0.1';
  config.relay.port = TARGET_PORT;
  config.relay.publicUrl = `http://127.0.0.1:${TARGET_PORT}`;
  config.auth.password = null;
  config.auth.adminToken = null;
  config.auth.stateFile = stateFile;

  relayServer = new RelayServer(config, {
    devLatencyMs,
  });

  let address;
  try {
    address = await relayServer.listen(TARGET_PORT, config.relay.host);
  } catch (err) {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) {
      process.stdout.write(
        `[e2e-harness] Port ${TARGET_PORT} in use, choosing available port...\n`,
      );
      address = await relayServer.listen(0, config.relay.host);
    } else {
      throw err;
    }
  }

  const boundPort = address.port;
  relayServer.config.relay.publicUrl = `http://127.0.0.1:${boundPort}`;

  // Connect mock host connector
  const wsUrl = `ws://127.0.0.1:${boundPort}/ws/host`;
  hostWs = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for host connection handshake'));
    }, 10000);

    hostWs.on('open', () => {
      hostWs.send(
        JSON.stringify({
          type: 'host_hello',
          protocol: PROTOCOL_VERSION,
          hostId: HOST_ID,
          token: HOST_TOKEN,
          password: null,
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          terminalPalette: null,
          capabilities: ['host_handoff', 'idle_heartbeat', 'binary_frame_v2'],
        }),
      );
    });

    hostWs.on('message', (raw, isBinary) => {
      if (!isBinary) {
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }

        if (msg.type === 'host_ready') {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'error' && !msg.clientId) {
          clearTimeout(timeout);
          reject(new Error(`Host handshake failed: ${msg.message || msg.code}`));
        }
      }
    });

    hostWs.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Keep host alive with periodic heartbeat
  heartbeatTimer = setInterval(() => {
    if (hostWs && hostWs.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({ type: 'heartbeat', load: {}, ptys: [] }));
    }
  }, 15000);

  // Set up host message routing for mock shell sessions
  hostWs.on('message', (raw, isBinary) => {
    if (isBinary) {
      let frame;
      try {
        frame = unpackStreamFrame(raw);
      } catch {
        // Not a stream frame; nothing for the fake shell.
        return;
      }

      if (frame.type !== 'input') return;

      const streamId =
        frame.version === 2 ? streamIndexToId.get(frame.streamIndex) : frame.streamId;
      if (!streamId) return;

      const session = sessions.get(streamId);
      if (!session) return;

      handleShellInput(session, frame.payload, (data) => sendOutput(session, data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'session_start') {
      const streamId = msg.streamId || msg.clientId;
      const streamIndex = typeof msg.streamIndex === 'number' ? msg.streamIndex : null;

      const session = {
        streamId,
        streamIndex,
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        lineBuffer: '',
        lastWasCr: false,
        flooding: false,
      };

      sessions.set(streamId, session);
      if (typeof streamIndex === 'number') {
        streamIndexToId.set(streamIndex, streamId);
      }

      // Confirm session is ready
      hostWs.send(
        JSON.stringify({
          type: 'session_ready',
          clientId: streamId,
          streamId,
        }),
      );

      // Print initial shell prompt
      sendOutput(session, '\r\n$ ');
    } else if (msg.type === 'session_stop') {
      const streamId = msg.streamId || msg.clientId;
      if (streamId) {
        const session = sessions.get(streamId);
        if (session) session.stopped = true;
        if (session && typeof session.streamIndex === 'number') {
          streamIndexToId.delete(session.streamIndex);
        }
        sessions.delete(streamId);
      }
    } else if (msg.type === 'resize') {
      const streamId = msg.streamId || msg.clientId;
      const session = streamId ? sessions.get(streamId) : null;
      if (session) {
        session.cols = msg.cols || session.cols;
        session.rows = msg.rows || session.rows;
      }
    }
  });

  // Request pairing code
  const pairing = await requestPairing(boundPort);

  // Print status
  const latencyDisplay =
    devLatencyMs > 0
      ? `${devLatencyMs} ms (RTT, ~${Math.round(devLatencyMs / 2)} ms one-way)`
      : '0 ms (disabled, real-time)';

  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write('  Herdr Remote E2E Latency Harness\n');
  process.stdout.write(`${'='.repeat(64)}\n`);
  process.stdout.write(`  Relay Address:   http://127.0.0.1:${boundPort}\n`);
  process.stdout.write(`  Pairing URL:     ${pairing.pairUrl}\n`);
  process.stdout.write(`  Pairing Code:    ${pairing.code}\n`);
  process.stdout.write(`  Latency Switch:  ${latencyDisplay}\n`);
  process.stdout.write(`${'='.repeat(64)}\n`);
  process.stdout.write('  Instructions:\n');
  process.stdout.write('  1. Open the Pairing URL above in your browser.\n');
  process.stdout.write('  2. Type characters to verify predictive echo and latency.\n');
  process.stdout.write('  3. Type "flood" and press Enter to test 2000-line burst.\n');
  process.stdout.write('  4. Press Ctrl+C in this terminal to stop and clean up.\n');
  process.stdout.write(`${'='.repeat(64)}\n\n`);
}

main().catch(async (err) => {
  process.stderr.write(`\n[e2e-harness] FATAL ERROR: ${err.stack || err.message}\n`);
  await cleanup('FATAL');
  process.exit(1);
});
