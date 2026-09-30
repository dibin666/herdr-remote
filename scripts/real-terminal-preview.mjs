#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayServer } from '../packages/relay/dist/relay-server.js';
import { installLatencyControls } from './lib/latency-controls.mjs';

// Isolate preview credentials and locks while reading the user's existing Herdr configuration.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-real-preview-'));
process.env.HERDR_REMOTE_STATE_DIR = directory;
const { loadConfig } = await import('../packages/cli/dist/config.js');
const { resolveSocketPath, inspectSocket } = await import(
  '../packages/cli/dist/socket-discovery.js'
);
const { probeHerdrServer } = await import('../packages/cli/dist/herdr-server.js');
const { HostConnector } = await import('../packages/cli/dist/connector/host-connector.js');
const { requestJson } = await import('../packages/cli/dist/relay-client.js');
const config = loadConfig();
config.herdr.autoStart = false;
const socketPath = resolveSocketPath(config.herdr.socketPath);
const port = Number(process.env.PORT || 8899);
const origin = `http://127.0.0.1:${port}`;
const hostId = `real-preview-${crypto.randomUUID()}`;
const hostToken = crypto.randomBytes(32).toString('hex');
const relay = new RelayServer(
  { relay: { mode: 'local', publicUrl: origin } },
  {
    stateFile: path.join(directory, 'relay-auth.json'),
    devLatencyMs: process.env.RELAY_DEV_LATENCY_MS || 200,
  },
);
let connector;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  connector?.stop();
  await relay.close();
  fs.rmSync(directory, { recursive: true, force: true });
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  if (!inspectSocket(socketPath).ok || (await probeHerdrServer(socketPath)).state !== 'running') {
    throw new Error('The configured Herdr server is not running');
  }
  await relay.listen(port, '127.0.0.1');
  connector = new HostConnector({
    config,
    hostId,
    hostToken,
    socketPath,
    relayUrl: `ws://127.0.0.1:${port}/ws/host`,
    relayPassword: '',
    lockPath: path.join(directory, 'connector.lock'),
    herdrLogPath: path.join(directory, 'herdr.log'),
    checkUpdate: null,
  });
  connector.start();
  const deadline = Date.now() + 10_000;
  while (!relay.hosts.has(hostId)) {
    if (Date.now() >= deadline) throw new Error('The real host connector did not register');
    await delay(50);
  }
  installLatencyControls(
    relay,
    async () => {
      const pairing = await requestJson(`${origin}/api/pair/start`, {
        method: 'POST',
        headers: { 'X-Herdr-Host-Id': hostId, 'X-Herdr-Host-Token': hostToken },
      });
      return pairing.pairUrl;
    },
    { terminalMode: 'real' },
  );
  process.stdout.write(
    `Real terminal WebUI: ${origin}/__test__\nAdded round-trip delay: ${relay.devLatencyMs} ms\nReal host connector registered; terminal sessions open when the user connects.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  await stop();
  process.exitCode = 1;
}
