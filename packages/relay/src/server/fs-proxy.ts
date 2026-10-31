// Directory listings and file downloads between a window and its workstation.
// Requests are answered in place; downloads are staged on the host and pulled
// a slice at a time, so a file never queues ahead of terminal output.

import {
  type ClientFsDeleteRequestMessage,
  type ClientFsDownloadChunkRequestMessage,
  type ClientFsDownloadRequestMessage,
  type ClientFsListRequestMessage,
  type ClientFsPreviewRequestMessage,
  type ClientFsRenameRequestMessage,
  FS_CWD_MAX_CHARS,
  FS_DOWNLOAD_CHUNK_BYTES,
  FS_DOWNLOAD_MAX_BYTES,
  FS_DOWNLOAD_MAX_NAMES,
  FS_LIST_MAX_ENTRIES,
  FS_PREVIEW_MAX_BYTES,
  FS_REQUEST_ID,
  type FsListEntry,
  type HostFsDownloadChunkMessage,
  type HostFsDownloadReadyMessage,
  type HostFsListResponseMessage,
  type HostFsMutationDoneMessage,
  type HostFsPreviewResponseMessage,
  isFsEntryName,
  isFsListDir,
} from '../protocol/index.js';
import { isOpen, jsonSend } from './sockets.js';
import type { RelayClient, RelayHost } from './types.js';

/** Download slices a window may have outstanding. */
const MAX_FS_CHUNKS_IN_FLIGHT = 4;

/** An unanswered slice stops counting against the window after this long. */
const FS_CHUNK_TIMEOUT_MS = 30_000;

/**
 * A window may ask for a fresh listing at most this often — enough to stop a
 * listing flood, short enough that clicking through folders feels instant.
 */
const FS_LIST_REPEAT_MS = 200;

/** Transfers a window may hold open at once; older ones stop being fetchable. */
const MAX_FS_TRANSFERS_PER_CLIENT = 8;

/** Base64 of one full chunk, the most an `fs_download_chunk` may carry. */
const MAX_FS_CHUNK_BASE64 = Math.ceil(FS_DOWNLOAD_CHUNK_BYTES / 3) * 4;

function rejectFs(client: RelayClient, code: string, text: string, requestId?: unknown): void {
  jsonSend(client.ws, {
    type: 'error',
    code,
    message: text,
    ...(typeof requestId === 'string' ? { requestId } : {}),
  });
}

/** Every fs request needs a live session on a host new enough to answer it. */
function fsGate(
  host: RelayHost,
  client: RelayClient,
  requestId: unknown,
): client is RelayClient & { session: { streamId: string } } {
  if (!host.fsBrowse) {
    rejectFs(
      client,
      'fs_unsupported',
      'Host is too old to share files; update herdr-remote',
      requestId,
    );
    return false;
  }
  if (!client.session) {
    rejectFs(client, 'no_session', 'Terminal session is not ready', requestId);
    return false;
  }
  if (!isOpen(host.ws)) {
    rejectFs(client, 'host_offline', 'Host is offline or disconnected', requestId);
    return false;
  }
  if (typeof requestId !== 'string' || !FS_REQUEST_ID.test(requestId)) return false;
  return true;
}

/** The window asks for the listing of its terminal's working directory. */
export function requestFsList(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsListRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  if (message.dir !== undefined && !isFsListDir(message.dir)) return;
  const now = Date.now();
  if (client.fsListAt && now - client.fsListAt < FS_LIST_REPEAT_MS) return;
  client.fsListAt = now;
  jsonSend(host.ws, {
    type: 'fs_list_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    ...(message.dir === undefined ? {} : { dir: message.dir }),
  });
}

/** The window picked names out of the listing to download. */
export function requestFsDownload(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsDownloadRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  const names = Array.isArray(message.names) ? message.names : null;
  if (!names || names.length === 0 || names.length > FS_DOWNLOAD_MAX_NAMES) return;
  const picked = new Set<string>();
  for (const name of names) {
    if (!isFsEntryName(name) || picked.has(name)) return;
    picked.add(name);
  }
  jsonSend(host.ws, {
    type: 'fs_download_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    names: [...picked],
  });
}

/** The window pulls one slice of a transfer the workstation announced. */
export function requestFsChunk(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsDownloadChunkRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  const total = client.fsDownloads?.get(message.requestId);
  if (
    total === undefined ||
    !Number.isInteger(message.index) ||
    message.index < 0 ||
    message.index >= total
  ) {
    rejectFs(
      client,
      'fs_download_unavailable',
      'The workstation did not stage this download',
      message.requestId,
    );
    return;
  }
  const now = Date.now();
  client.fsChunkRequests = (client.fsChunkRequests || []).filter(
    (at) => now - at < FS_CHUNK_TIMEOUT_MS,
  );
  if (client.fsChunkRequests.length >= MAX_FS_CHUNKS_IN_FLIGHT) return;
  client.fsChunkRequests.push(now);
  jsonSend(host.ws, {
    type: 'fs_download_chunk_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    index: message.index,
  });
}

/** One listing answer the workstation owes the window that asked. */
export function forwardFsList(client: RelayClient, message: HostFsListResponseMessage): void {
  if (typeof message.requestId !== 'string' || !FS_REQUEST_ID.test(message.requestId)) return;
  const cwd = typeof message.cwd === 'string' ? message.cwd.slice(0, FS_CWD_MAX_CHARS) : '';
  if (!cwd) return;
  const entries: FsListEntry[] = [];
  if (Array.isArray(message.entries)) {
    for (const raw of message.entries) {
      if (entries.length >= FS_LIST_MAX_ENTRIES) break;
      const entry = raw as FsListEntry;
      if (!isFsEntryName(entry?.name)) continue;
      const kind = entry.kind === 'dir' ? 'dir' : 'file';
      const size = Number.isFinite(entry.size) && entry.size > 0 ? Math.floor(entry.size) : 0;
      const mtimeMs = Number.isFinite(entry.mtimeMs) ? Math.floor(entry.mtimeMs) : 0;
      entries.push({ name: entry.name, kind, size: kind === 'dir' ? 0 : size, mtimeMs });
    }
  }
  jsonSend(client.ws, {
    type: 'fs_list_response',
    requestId: message.requestId,
    cwd,
    entries,
  });
}

/**
 * The workstation staged a download: register it so only this window can pull
 * its slices, then tell the window it is ready.
 */
export function forwardFsReady(client: RelayClient, message: HostFsDownloadReadyMessage): void {
  const valid =
    typeof message.requestId === 'string' &&
    FS_REQUEST_ID.test(message.requestId) &&
    isFsEntryName(message.name) &&
    // An empty file still transfers: one empty slice delivers it.
    Number.isInteger(message.size) &&
    message.size >= 0 &&
    message.size <= FS_DOWNLOAD_MAX_BYTES &&
    Number.isInteger(message.totalChunks) &&
    message.totalChunks > 0 &&
    message.totalChunks <= Math.ceil(FS_DOWNLOAD_MAX_BYTES / FS_DOWNLOAD_CHUNK_BYTES);
  if (!valid) return;
  client.fsDownloads ||= new Map();
  client.fsDownloads.delete(message.requestId);
  client.fsDownloads.set(message.requestId, message.totalChunks);
  while (client.fsDownloads.size > MAX_FS_TRANSFERS_PER_CLIENT) {
    const oldest = client.fsDownloads.keys().next().value;
    if (oldest === undefined) break;
    client.fsDownloads.delete(oldest);
  }
  jsonSend(client.ws, {
    type: 'fs_download_ready',
    requestId: message.requestId,
    name: message.name,
    size: message.size,
    totalChunks: message.totalChunks,
  });
}

/** The window wants to read a listed file. */
export function requestFsPreview(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsPreviewRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  if (!isFsEntryName(message.name)) return;
  jsonSend(host.ws, {
    type: 'fs_preview_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    name: message.name,
  });
}

/** The window wants a listed entry renamed inside the same directory. */
export function requestFsRename(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsRenameRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  if (!isFsEntryName(message.name) || !isFsEntryName(message.newName)) return;
  jsonSend(host.ws, {
    type: 'fs_rename_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    name: message.name,
    newName: message.newName,
  });
}

/** The window wants a listed entry gone. */
export function requestFsDelete(
  host: RelayHost,
  client: RelayClient,
  message: ClientFsDeleteRequestMessage,
): void {
  if (!fsGate(host, client, message.requestId)) return;
  if (!isFsEntryName(message.name)) return;
  jsonSend(host.ws, {
    type: 'fs_delete_request',
    clientId: client.session.streamId,
    streamId: client.session.streamId,
    requestId: message.requestId,
    name: message.name,
  });
}

/** The file's text the workstation read for the window. */
export function forwardFsPreview(client: RelayClient, message: HostFsPreviewResponseMessage): void {
  if (typeof message.requestId !== 'string' || !FS_REQUEST_ID.test(message.requestId)) return;
  if (!isFsEntryName(message.name) || typeof message.text !== 'string') return;
  jsonSend(client.ws, {
    type: 'fs_preview_response',
    requestId: message.requestId,
    name: message.name,
    text: message.text.slice(0, FS_PREVIEW_MAX_BYTES),
    truncated: message.truncated === true,
  });
}

/** A rename or delete the workstation confirmed. */
export function forwardFsMutationDone(
  client: RelayClient,
  message: HostFsMutationDoneMessage,
): void {
  if (typeof message.requestId !== 'string' || !FS_REQUEST_ID.test(message.requestId)) return;
  jsonSend(client.ws, { type: 'fs_mutation_done', requestId: message.requestId });
}

/** One slice of a staged transfer, checked against what was announced. */
export function forwardFsChunk(client: RelayClient, message: HostFsDownloadChunkMessage): void {
  const total = client.fsDownloads?.get(message.requestId);
  const valid =
    total !== undefined &&
    Number.isInteger(message.index) &&
    message.index >= 0 &&
    message.index < total &&
    typeof message.dataBase64 === 'string' &&
    message.dataBase64.length <= MAX_FS_CHUNK_BASE64;
  if (!valid) return;
  if (Array.isArray(client.fsChunkRequests) && client.fsChunkRequests.length)
    client.fsChunkRequests.shift();
  // The last slice ends the transfer; anything after it is not this window's.
  if (message.index === total - 1) client.fsDownloads?.delete(message.requestId);
  jsonSend(client.ws, {
    type: 'fs_download_chunk',
    requestId: message.requestId,
    index: message.index,
    dataBase64: message.dataBase64,
  });
}
