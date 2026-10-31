import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../src/relay-server';
import { nextJson, nextMessage, openWebSocket, postJson, relayConfig } from './helpers.js';

const HOST_AUTH = { 'X-Herdr-Host-Id': 'host-test', 'X-Herdr-Host-Token': 'host-token-secret' };

async function startRelay(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fs-test-'));
  const server = new RelayServer(relayConfig(config), { stateFile: path.join(dir, 'auth.json') });
  const address = await server.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    wsBase: `ws://127.0.0.1:${address.port}`,
  };
}

async function connectHost(wsBase, { fsBrowse = true } = {}) {
  const ws = await openWebSocket(`${wsBase}/ws/host`);
  const ready = nextJson(ws, (msg) => msg.type === 'host_ready');
  ws.send(
    JSON.stringify({
      type: 'host_hello',
      protocol: 1,
      hostId: 'host-test',
      token: HOST_AUTH['X-Herdr-Host-Token'],
      capabilities: fsBrowse ? ['fs_browse'] : [],
    }),
  );
  await ready;
  return ws;
}

async function connectClient(base, wsBase) {
  const pairing = await postJson(`${base}/api/pair/start`, HOST_AUTH);
  const ws = await openWebSocket(`${wsBase}/ws/client`);
  const ready = nextJson(ws, (msg) => msg.type === 'ready');
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol: 1,
      pairCode: pairing.code,
      clientId: 'browser-test',
      cols: 80,
      rows: 24,
    }),
  );
  await ready;
  return { ws };
}

test('a list request reaches the host stamped with the window stream, and its answer returns', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  const forwarded = nextJson(host, (msg) => msg.type === 'fs_list_request');
  client.send(JSON.stringify({ type: 'fs_list_request', requestId: 'list-1' }));
  const request = await forwarded;
  assert.equal(request.requestId, 'list-1');
  assert.ok(request.streamId && request.clientId === request.streamId);

  const answer = nextJson(client, (msg) => msg.type === 'fs_list_response');
  host.send(
    JSON.stringify({
      type: 'fs_list_response',
      clientId: request.clientId,
      requestId: 'list-1',
      cwd: '/tmp/work',
      entries: [
        { name: 'a.txt', kind: 'file', size: 5, mtimeMs: 1 },
        { name: '../evil', kind: 'file', size: 1, mtimeMs: 1 },
        { name: 'sub', kind: 'dir', size: 99, mtimeMs: 2 },
      ],
    }),
  );
  const listing = await answer;
  assert.equal(listing.cwd, '/tmp/work');
  assert.deepEqual(listing.entries, [
    { name: 'a.txt', kind: 'file', size: 5, mtimeMs: 1 },
    // Traversal names are dropped, and a dir's size is not trusted.
    { name: 'sub', kind: 'dir', size: 0, mtimeMs: 2 },
  ]);

  client.close();
  host.close();
});

test('fs requests to a host without fs_browse are refused with fs_unsupported', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase, { fsBrowse: false });
  const { ws: client } = await connectClient(base, wsBase);

  const errorMsg = nextJson(client, (msg) => msg.type === 'error');
  client.send(JSON.stringify({ type: 'fs_list_request', requestId: 'list-1' }));
  const error = await errorMsg;
  assert.equal(error.code, 'fs_unsupported');
  assert.equal(error.requestId, 'list-1');

  client.close();
  host.close();
});

test('a download is staged and pulled one slice at a time', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  const forwarded = nextJson(host, (msg) => msg.type === 'fs_download_request');
  client.send(
    JSON.stringify({ type: 'fs_download_request', requestId: 'dl-1', names: ['a.txt', 'b.txt'] }),
  );
  const request = await forwarded;
  assert.deepEqual(request.names, ['a.txt', 'b.txt']);
  assert.ok(request.streamId);

  const readyMessage = nextJson(client, (msg) => msg.type === 'fs_download_ready');
  host.send(
    JSON.stringify({
      type: 'fs_download_ready',
      clientId: request.clientId,
      requestId: 'dl-1',
      name: 'work.zip',
      size: 10,
      totalChunks: 2,
    }),
  );
  const ready = await readyMessage;
  assert.equal(ready.name, 'work.zip');
  assert.equal(ready.totalChunks, 2);

  // Slices only flow for the announced transfer, and only to its window.
  const chunkRequest = nextJson(host, (msg) => msg.type === 'fs_download_chunk_request');
  client.send(JSON.stringify({ type: 'fs_download_chunk_request', requestId: 'dl-1', index: 0 }));
  const asked = await chunkRequest;
  assert.equal(asked.index, 0);
  assert.ok(asked.streamId);

  const first = nextJson(client, (msg) => msg.type === 'fs_download_chunk');
  host.send(
    JSON.stringify({
      type: 'fs_download_chunk',
      clientId: request.clientId,
      requestId: 'dl-1',
      index: 0,
      dataBase64: Buffer.from('hello').toString('base64'),
    }),
  );
  const chunk = await first;
  assert.equal(chunk.index, 0);
  assert.equal(Buffer.from(chunk.dataBase64, 'base64').toString(), 'hello');

  client.close();
  host.close();
});

test('a chunk request for an unstaged transfer is refused', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  const errorMsg = nextJson(client, (msg) => msg.type === 'error');
  client.send(JSON.stringify({ type: 'fs_download_chunk_request', requestId: 'dl-x', index: 0 }));
  const error = await errorMsg;
  assert.equal(error.code, 'fs_download_unavailable');

  client.close();
  host.close();
});

test('a download request carrying a path or a bad name is dropped', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  for (const names of [['../secret'], ['dir/file'], ['ok.txt', 'ok.txt']]) {
    const forwarded = nextMessage(host, () => false, 100).catch(() => null);
    client.send(JSON.stringify({ type: 'fs_download_request', requestId: 'dl-bad', names }));
    const result = await forwarded;
    assert.equal(result, null, `names ${JSON.stringify(names)} must not reach the host`);
  }

  client.close();
  host.close();
});

test('a list request with dir forwards the relative step', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  for (const [dir, id] of [
    ['..', 'l-up'],
    ['.', 'l-same'],
    ['subdir', 'l-into'],
  ]) {
    const forwarded = nextJson(host, (msg) => msg.type === 'fs_list_request' && msg.dir === dir);
    client.send(JSON.stringify({ type: 'fs_list_request', requestId: id, dir }));
    const request = await forwarded;
    assert.equal(request.dir, dir);
    // The relay's list rate limiter does not swallow back-to-back navigation.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // A path or a name the host never listed does not reach it.
  for (const dir of ['../etc', 'sub/child', '', 'x'.repeat(300)]) {
    const forwarded = nextMessage(host, () => false, 100).catch(() => null);
    client.send(JSON.stringify({ type: 'fs_list_request', requestId: 'lb', dir }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await forwarded;
    assert.equal(result, null, `dir ${JSON.stringify(dir)} must not reach the host`);
  }

  client.close();
  host.close();
});

test('preview, rename and delete requests reach the host, answers reach the window', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  const previewReq = nextJson(host, (msg) => msg.type === 'fs_preview_request');
  client.send(JSON.stringify({ type: 'fs_preview_request', requestId: 'pv-1', name: 'a.txt' }));
  const pv = await previewReq;
  assert.equal(pv.name, 'a.txt');
  assert.ok(pv.streamId);

  const previewResp = nextJson(client, (msg) => msg.type === 'fs_preview_response');
  host.send(
    JSON.stringify({
      type: 'fs_preview_response',
      clientId: pv.clientId,
      requestId: 'pv-1',
      name: 'a.txt',
      text: 'content',
      truncated: false,
    }),
  );
  const resp = await previewResp;
  assert.equal(resp.text, 'content');
  assert.equal(resp.truncated, false);

  const renameReq = nextJson(host, (msg) => msg.type === 'fs_rename_request');
  client.send(
    JSON.stringify({
      type: 'fs_rename_request',
      requestId: 'mv-1',
      name: 'a.txt',
      newName: 'b.txt',
    }),
  );
  const mv = await renameReq;
  assert.equal(mv.newName, 'b.txt');

  const doneMsg = nextJson(client, (msg) => msg.type === 'fs_mutation_done');
  host.send(JSON.stringify({ type: 'fs_mutation_done', clientId: mv.clientId, requestId: 'mv-1' }));
  assert.equal((await doneMsg).requestId, 'mv-1');

  const deleteReq = nextJson(host, (msg) => msg.type === 'fs_delete_request');
  client.send(JSON.stringify({ type: 'fs_delete_request', requestId: 'rm-1', name: 'b.txt' }));
  assert.equal((await deleteReq).name, 'b.txt');

  client.close();
  host.close();
});

test('bad names on preview, rename and delete are dropped before the host', async (t) => {
  const { base, wsBase } = await startRelay(t);
  const host = await connectHost(wsBase);
  const { ws: client } = await connectClient(base, wsBase);

  const gone = () => nextMessage(host, () => false, 100).catch(() => null);
  client.send(JSON.stringify({ type: 'fs_preview_request', requestId: 'p', name: '../x' }));
  assert.equal(await gone(), null);
  client.send(
    JSON.stringify({ type: 'fs_rename_request', requestId: 'r', name: 'a', newName: 'dir/b' }),
  );
  assert.equal(await gone(), null);
  client.send(JSON.stringify({ type: 'fs_delete_request', requestId: 'd', name: './a' }));
  assert.equal(await gone(), null);

  client.close();
  host.close();
});
