import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../src/relay-server';
import { nextMessage, openWebSocket, postJson, relayConfig } from './helpers.js';

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-test', 'X-Herdr-Host-Token': 'host-token-secret' };

async function relayWithHostAndClient(t, capabilities) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-test-'));
  const server = new RelayServer(relayConfig({ maxPayloadBytes: 5 * 1024 * 1024 }), {
    stateFile: path.join(dir, 'auth.json'),
  });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostWs = await openWebSocket(`${wsBase}/ws/host`);
  const hostReady = nextMessage(hostWs, (msg) => msg.type === 'host_ready');
  hostWs.send(
    JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-test',
      token: HOST_AUTH['X-Herdr-Host-Token'],
      capabilities,
    }),
  );
  await hostReady;

  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const client = await openWebSocket(`${wsBase}/ws/client`);
  const ready = nextMessage(client, (msg) => msg.type === 'ready');
  client.send(
    JSON.stringify({
      type: 'hello',
      protocol: 1,
      pairCode: pairing.code,
      clientId: 'browser-a',
      cols: 80,
      rows: 24,
    }),
  );
  const readyMsg = (await ready).value;
  t.onTestFinished(() => {
    client.close();
    hostWs.close();
  });
  return { hostWs, client, readyMsg };
}

test('chunked upload: begin registers, host pulls slices, ready closes it', async (t) => {
  const { hostWs, client, readyMsg } = await relayWithHostAndClient(t, [
    'paste_stream',
    'paste_any_file',
  ]);
  assert.equal(readyMsg.pasteStreamSupported, true);

  // The window announces an upload; the host sees it with the stream stamped.
  const hostGotBegin = nextMessage(hostWs, (msg) => msg.type === 'paste_file_begin');
  client.send(
    JSON.stringify({
      type: 'paste_file_begin',
      requestId: 'up1',
      mime: 'application/octet-stream',
      name: 'movie.mp4',
      size: 300 * 1024,
    }),
  );
  const begin = (await hostGotBegin).value;
  assert.equal(begin.requestId, 'up1');
  assert.equal(begin.size, 300 * 1024);
  assert.equal(begin.name, 'movie.mp4');
  assert.ok(begin.streamId, 'must carry streamId');

  // The host pulls two slices; the window is asked for exactly those.
  const pull0 = nextMessage(client, (msg) => msg.type === 'paste_file_chunk_request');
  hostWs.send(
    JSON.stringify({
      type: 'paste_file_chunk_request',
      clientId: begin.streamId,
      requestId: 'up1',
      index: 0,
    }),
  );
  assert.equal((await pull0).value.index, 0);

  const pull1 = nextMessage(client, (msg) => msg.type === 'paste_file_chunk_request');
  hostWs.send(
    JSON.stringify({
      type: 'paste_file_chunk_request',
      clientId: begin.streamId,
      requestId: 'up1',
      index: 1,
    }),
  );
  assert.equal((await pull1).value.index, 1);

  // Answered slices reach the host, in any order.
  const gotChunk1 = nextMessage(
    hostWs,
    (msg) => msg.type === 'paste_file_chunk' && msg.index === 1,
  );
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up1',
      index: 1,
      dataBase64: Buffer.from('second').toString('base64'),
    }),
  );
  assert.equal((await gotChunk1).value.dataBase64, Buffer.from('second').toString('base64'));

  const gotChunk0 = nextMessage(
    hostWs,
    (msg) => msg.type === 'paste_file_chunk' && msg.index === 0,
  );
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up1',
      index: 0,
      dataBase64: Buffer.from('first').toString('base64'),
    }),
  );
  await gotChunk0;

  // Ready carries the request id back to the window.
  const readyBack = nextMessage(client, (msg) => msg.type === 'paste_file_ready');
  hostWs.send(
    JSON.stringify({
      type: 'paste_file_ready',
      clientId: begin.streamId,
      path: '/state/pasted/uuid-movie.mp4',
      requestId: 'up1',
    }),
  );
  const ready = (await readyBack).value;
  assert.equal(ready.path, '/state/pasted/uuid-movie.mp4');
  assert.equal(ready.requestId, 'up1');
});

test('a slice the host never asked for is dropped, not forwarded', async (t) => {
  const { hostWs, client } = await relayWithHostAndClient(t, ['paste_stream', 'paste_any_file']);
  const hostGotBegin = nextMessage(hostWs, (msg) => msg.type === 'paste_file_begin');
  client.send(
    JSON.stringify({
      type: 'paste_file_begin',
      requestId: 'up2',
      mime: 'application/octet-stream',
      name: 'a.bin',
      size: 1024,
    }),
  );
  const begin = (await hostGotBegin).value;

  let chunksAtHost = 0;
  hostWs.on('message', (data) => {
    if (JSON.parse(data.toString()).type === 'paste_file_chunk') chunksAtHost += 1;
  });

  // Pushed uninvited: index 0 was never requested.
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up2',
      index: 0,
      dataBase64: Buffer.from('x').toString('base64'),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chunksAtHost, 0);

  // Out-of-range indices never cross either.
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up2',
      index: 9,
      dataBase64: Buffer.from('x').toString('base64'),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chunksAtHost, 0);

  // Once the host asks, the answer crosses; a duplicate then does not.
  const pull = nextMessage(client, (msg) => msg.type === 'paste_file_chunk_request');
  hostWs.send(
    JSON.stringify({
      type: 'paste_file_chunk_request',
      clientId: begin.streamId,
      requestId: 'up2',
      index: 0,
    }),
  );
  await pull;
  const first = nextMessage(hostWs, (msg) => msg.type === 'paste_file_chunk');
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up2',
      index: 0,
      dataBase64: Buffer.from('x').toString('base64'),
    }),
  );
  await first;
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up2',
      index: 0,
      dataBase64: Buffer.from('y').toString('base64'),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chunksAtHost, 1);
});

test('begin on a host without paste_stream is refused as outdated', async (t) => {
  const { client, readyMsg } = await relayWithHostAndClient(t, ['paste_any_file']);
  assert.equal(readyMsg.pasteStreamSupported, false);

  const res = nextMessage(client, (msg) => msg.type === 'error');
  client.send(
    JSON.stringify({
      type: 'paste_file_begin',
      requestId: 'up3',
      mime: 'application/octet-stream',
      name: 'a.bin',
      size: 1024,
    }),
  );
  const err = (await res).value;
  assert.equal(err.code, 'paste_file_host_outdated');
  assert.equal(err.requestId, 'up3');
});

test('an image whose first slice fails the signature check is rejected', async (t) => {
  const { hostWs, client } = await relayWithHostAndClient(t, ['paste_stream', 'paste_any_file']);
  const hostGotBegin = nextMessage(hostWs, (msg) => msg.type === 'paste_file_begin');
  client.send(
    JSON.stringify({
      type: 'paste_file_begin',
      requestId: 'up4',
      mime: 'image/png',
      size: 64,
    }),
  );
  const begin = (await hostGotBegin).value;

  const pull = nextMessage(client, (msg) => msg.type === 'paste_file_chunk_request');
  hostWs.send(
    JSON.stringify({
      type: 'paste_file_chunk_request',
      clientId: begin.streamId,
      requestId: 'up4',
      index: 0,
    }),
  );
  await pull;

  const res = nextMessage(client, (msg) => msg.type === 'error');
  client.send(
    JSON.stringify({
      type: 'paste_file_chunk',
      requestId: 'up4',
      index: 0,
      dataBase64: Buffer.from('NOT A REAL PNG FILE').toString('base64'),
    }),
  );
  const err = (await res).value;
  assert.equal(err.code, 'paste_file_unsupported');
  assert.equal(err.requestId, 'up4');
});
