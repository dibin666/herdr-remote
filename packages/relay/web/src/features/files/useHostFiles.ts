// Listing the terminal's working directory and pulling downloads from it,
// over the same socket as everything else. Requests wait for their answer by
// request id and give up after a while, on disconnect, or when the host says
// no — the same discipline font transfers use.

import { useCallback, useEffect, useRef } from 'react';
import type { FsListEntry } from '@protocol/files';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import { decodeBase64 } from '@/features/hostFont/hostFont';
import { newFsRequestId } from './fileList';

/** A listing that has not arrived by now is not coming. */
const LIST_TIMEOUT_MS = 15_000;
/** Building a zip can take the host a while; so can a slow socket. */
const READY_TIMEOUT_MS = 60_000;
/** One slice that has not arrived by now is not coming. */
const CHUNK_TIMEOUT_MS = 30_000;

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FsListResult {
  cwd: string;
  entries: FsListEntry[];
}

export interface FsPreviewResult {
  name: string;
  text: string;
  truncated: boolean;
}

interface PendingDownload extends Pending<{ name: string; blob: Blob }> {
  onProgress?: (received: number, total: number) => void;
}

export class FsRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function useHostFiles(adapter: HerdrClientAdapter | null) {
  const pendingListsRef = useRef(new Map<string, Pending<FsListResult>>());
  /** Staged or still-being-pulled downloads, by request id. */
  const pendingDownloadsRef = useRef(new Map<string, PendingDownload>());
  const pendingChunksRef = useRef(new Map<string, Pending<Uint8Array>>());
  const pendingPreviewsRef = useRef(new Map<string, Pending<FsPreviewResult>>());
  const pendingMutationsRef = useRef(new Map<string, Pending<void>>());

  const rejectAll = useCallback((code: string, message: string) => {
    for (const map of [
      pendingListsRef.current,
      pendingDownloadsRef.current,
      pendingChunksRef.current,
      pendingPreviewsRef.current,
      pendingMutationsRef.current,
    ] as Array<Map<string, Pending<unknown>>>) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new FsRequestError(code, message));
      }
      map.clear();
    }
  }, []);

  /** Reject one download and every slice of it still in flight. */
  const rejectDownload = useCallback((requestId: string, code: string, message: string) => {
    const waiting = pendingDownloadsRef.current.get(requestId);
    if (waiting) {
      pendingDownloadsRef.current.delete(requestId);
      clearTimeout(waiting.timer);
      waiting.reject(new FsRequestError(code, message));
    }
    for (const [key, chunk] of pendingChunksRef.current) {
      if (!key.startsWith(`${requestId}:`)) continue;
      pendingChunksRef.current.delete(key);
      clearTimeout(chunk.timer);
      chunk.reject(new FsRequestError(code, message));
    }
  }, []);

  const requestChunk = useCallback(
    (requestId: string, index: number) =>
      new Promise<Uint8Array>((resolve, reject) => {
        if (adapter?.getState() !== 'connected') {
          reject(new FsRequestError('disconnected', 'the connection dropped'));
          return;
        }
        const key = `${requestId}:${index}`;
        const timer = setTimeout(() => {
          pendingChunksRef.current.delete(key);
          reject(new FsRequestError('fs_timeout', 'the workstation stopped answering'));
        }, CHUNK_TIMEOUT_MS);
        pendingChunksRef.current.set(key, { resolve, reject, timer });
        adapter?.sendFsDownloadChunkRequest(requestId, index);
      }),
    [adapter],
  );

  /**
   * The entries of the terminal's current working directory — or, with `dir`,
   * a step relative to the last listing: `'.'` re-reads it, `'..'` its parent,
   * a name the directory it lists.
   */
  const listFiles = useCallback(
    (dir?: string): Promise<FsListResult> => {
      return new Promise<FsListResult>((resolve, reject) => {
        // sendJson drops messages while the socket is not open, so check.
        if (adapter?.getState() !== 'connected') {
          reject(new FsRequestError('disconnected', 'no connection'));
          return;
        }
        const requestId = newFsRequestId();
        const timer = setTimeout(() => {
          pendingListsRef.current.delete(requestId);
          reject(new FsRequestError('fs_timeout', 'the workstation stopped answering'));
        }, LIST_TIMEOUT_MS);
        pendingListsRef.current.set(requestId, { resolve, reject, timer });
        adapter.sendFsListRequest(requestId, dir);
      });
    },
    [adapter],
  );

  /**
   * Stage `names` of the last listing on the host, then pull the transfer it
   * announced a slice at a time. Resolves with the suggested name and the
   * assembled bytes.
   */
  const downloadFiles = useCallback(
    (
      names: string[],
      onProgress?: (received: number, total: number) => void,
    ): Promise<{ name: string; blob: Blob }> => {
      return new Promise<{ name: string; blob: Blob }>((resolve, reject) => {
        if (adapter?.getState() !== 'connected' || names.length === 0) {
          reject(new FsRequestError('disconnected', 'no connection'));
          return;
        }
        const requestId = newFsRequestId();
        const timer = setTimeout(() => {
          rejectDownload(requestId, 'fs_timeout', 'the workstation stopped answering');
        }, READY_TIMEOUT_MS);
        pendingDownloadsRef.current.set(requestId, {
          resolve,
          reject,
          timer,
          onProgress,
        });
        adapter.sendFsDownloadRequest(requestId, names);
      });
    },
    [adapter, rejectDownload],
  );

  /** The text of a listed file, as much as the host's preview cap allows. */
  const previewFile = useCallback(
    (name: string): Promise<FsPreviewResult> =>
      new Promise<FsPreviewResult>((resolve, reject) => {
        if (adapter?.getState() !== 'connected') {
          reject(new FsRequestError('disconnected', 'no connection'));
          return;
        }
        const requestId = newFsRequestId();
        const timer = setTimeout(() => {
          pendingPreviewsRef.current.delete(requestId);
          reject(new FsRequestError('fs_timeout', 'the workstation stopped answering'));
        }, LIST_TIMEOUT_MS);
        pendingPreviewsRef.current.set(requestId, { resolve, reject, timer });
        adapter.sendFsPreviewRequest(requestId, name);
      }),
    [adapter],
  );

  /** Rename or delete a listed entry; resolves when the host confirms. */
  const mutateEntry = useCallback(
    (send: (requestId: string) => void): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (adapter?.getState() !== 'connected') {
          reject(new FsRequestError('disconnected', 'no connection'));
          return;
        }
        const requestId = newFsRequestId();
        const timer = setTimeout(() => {
          pendingMutationsRef.current.delete(requestId);
          reject(new FsRequestError('fs_timeout', 'the workstation stopped answering'));
        }, LIST_TIMEOUT_MS);
        pendingMutationsRef.current.set(requestId, { resolve, reject, timer });
        send(requestId);
      }),
    [adapter],
  );

  const renameEntry = useCallback(
    (name: string, newName: string) =>
      mutateEntry((requestId) => adapter?.sendFsRenameRequest(requestId, name, newName)),
    [adapter, mutateEntry],
  );

  const deleteEntry = useCallback(
    (name: string) => mutateEntry((requestId) => adapter?.sendFsDeleteRequest(requestId, name)),
    [adapter, mutateEntry],
  );

  useEffect(() => {
    if (!adapter) return undefined;
    const pendingLists = pendingListsRef.current;
    const pendingDownloads = pendingDownloadsRef.current;
    const pendingChunks = pendingChunksRef.current;
    const pendingPreviews = pendingPreviewsRef.current;
    const pendingMutations = pendingMutationsRef.current;

    const offList = adapter.on('fsListResponse', (message) => {
      const waiting = pendingLists.get(message.requestId);
      if (!waiting) return;
      pendingLists.delete(message.requestId);
      clearTimeout(waiting.timer);
      waiting.resolve({ cwd: message.cwd, entries: message.entries });
    });

    const offReady = adapter.on('fsDownloadReady', (message) => {
      const waiting = pendingDownloads.get(message.requestId);
      if (!waiting) return;
      // The entry stays registered while slices are pulled, so an error or a
      // disconnect mid-transfer still finds who to fail.
      clearTimeout(waiting.timer);
      const onBytes = waiting.onProgress ?? (() => {});
      const parts: Uint8Array[] = [];
      (async () => {
        for (let index = 0; index < message.totalChunks; index++) {
          parts.push(await requestChunk(message.requestId, index));
          onBytes(
            parts.reduce((sum, part) => sum + part.length, 0),
            message.size,
          );
        }
      })()
        .then(() => {
          pendingDownloads.delete(message.requestId);
          waiting.resolve({ name: message.name, blob: new Blob(parts as BlobPart[]) });
        })
        .catch((error: unknown) => {
          pendingDownloads.delete(message.requestId);
          waiting.reject(
            error instanceof Error ? error : new FsRequestError('fs_failed', 'download failed'),
          );
        });
    });

    const offChunk = adapter.on('fsDownloadChunk', (message) => {
      const key = `${message.requestId}:${message.index}`;
      const waiting = pendingChunks.get(key);
      if (!waiting) return;
      pendingChunks.delete(key);
      clearTimeout(waiting.timer);
      try {
        waiting.resolve(decodeBase64(message.dataBase64));
      } catch {
        waiting.reject(new FsRequestError('fs_corrupt', 'corrupt download slice'));
      }
    });

    const offPreview = adapter.on('fsPreviewResponse', (message) => {
      const waiting = pendingPreviews.get(message.requestId);
      if (!waiting) return;
      pendingPreviews.delete(message.requestId);
      clearTimeout(waiting.timer);
      waiting.resolve({ name: message.name, text: message.text, truncated: message.truncated });
    });

    const offMutation = adapter.on('fsMutationDone', (message) => {
      const waiting = pendingMutations.get(message.requestId);
      if (!waiting) return;
      pendingMutations.delete(message.requestId);
      clearTimeout(waiting.timer);
      waiting.resolve();
    });

    const offError = adapter.on('error', (error) => {
      const code = typeof error.code === 'string' ? error.code : 'fs_failed';
      if (!code.startsWith('fs_')) return;
      const requestId = (error as { requestId?: string }).requestId;
      if (requestId) {
        for (const map of [pendingLists, pendingPreviews, pendingMutations] as Array<
          Map<string, Pending<unknown>>
        >) {
          const waiting = map.get(requestId);
          if (!waiting) continue;
          map.delete(requestId);
          clearTimeout(waiting.timer);
          waiting.reject(new FsRequestError(code, error.message));
          break;
        }
        rejectDownload(requestId, code, error.message);
        return;
      }
      // An fs error without a request id still belongs to whoever is waiting:
      // the dialog asks for one thing at a time.
      if (
        pendingLists.size > 0 ||
        pendingDownloads.size > 0 ||
        pendingPreviews.size > 0 ||
        pendingMutations.size > 0
      ) {
        rejectAll(code, error.message);
      }
    });

    const offState = adapter.on('stateChange', (next) => {
      if (next !== 'connected') rejectAll('disconnected', 'the connection dropped');
    });

    return () => {
      offList();
      offReady();
      offChunk();
      offPreview();
      offMutation();
      offError();
      offState();
      rejectAll('disconnected', 'the connection dropped');
    };
  }, [adapter, rejectAll, rejectDownload, requestChunk]);

  return { listFiles, downloadFiles, previewFile, renameEntry, deleteEntry };
}
