// The socket side of an upload: claiming the one upload slot this window has,
// driving its progress, and answering the workstation's pulls. useImageUpload
// adds per-file preparation and batching on top of it.
//
// Two transports share this pipeline. A host that pulls chunked uploads gets
// `paste_file_begin` and then answers `paste_file_chunk_request` with one
// 256 KB slice at a time — any size, no single giant message, and only the
// slices asked for are ever read. A host that predates that gets the one-shot
// `paste_file`, whole payload in one message, still capped at 3 MB.

import type { ClientRole } from '@protocol/messages';
import { PASTE_CHUNK_BYTES } from '@protocol/paste';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translate } from '@/shared/i18n';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import type { ConnectionState } from '@/connection/types';
import { newFsRequestId } from '@/features/files/fileList';
import {
  encodeBase64,
  IDLE_IMAGE_UPLOAD_PROGRESS,
  type ImageUploadProgress,
  type UploadKind,
} from '@/features/paste/imagePaste';
import type { ToastItem } from './useToastQueue';

/** How long the workstation may stay silent mid-upload before it is given up on. */
const UPLOAD_STALL_TIMEOUT_MS = 30_000;
/** How long "completed" stays on the progress bar. */
const UPLOAD_DONE_LINGER_MS = 1200;

/** The bytes of one slice of an upload's blob, read where it was asked for. */
function readBlobSlice(source: Blob, index: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read slice'));
    reader.readAsArrayBuffer(
      source.slice(index * PASTE_CHUNK_BYTES, index * PASTE_CHUNK_BYTES + PASTE_CHUNK_BYTES),
    );
  });
}

/** What the host's `paste_file_ready` resolves: the file it just confirmed. */
interface HostWaiter {
  taskId: number;
  resolve: (ok: boolean) => void;
  /** Part of a batch: the batch shows its own progress, not the flash. */
  quiet: boolean;
}

/** A chunked upload in flight: announced, answered slice by slice on demand. */
export interface PendingStreamUpload {
  taskId: number;
  requestId: string;
  resolve: (ok: boolean) => void;
  quiet: boolean;
  suffix: string;
  /** Bytes of a prepared image, or the blob the file picker handed over. */
  source: Uint8Array | Blob;
  size: number;
  totalChunks: number;
  sent: number;
}

export function useUploadTransport({
  adapterRef,
  role,
  connectionState,
  pasteStreamSupported,
  warnViewerMode,
  addToast,
  t,
  sendPasteFile,
}: {
  adapterRef: RefObject<HerdrClientAdapter | null>;
  role: ClientRole;
  connectionState: ConnectionState;
  pasteStreamSupported?: boolean;
  warnViewerMode: () => void;
  addToast: (type: ToastItem['type'], message: string) => void;
  t: Translate;
  sendPasteFile: (mime: string, dataBase64: string, name?: string) => boolean;
}) {
  const [progress, setUploadProgress] = useState<ImageUploadProgress>(IDLE_IMAGE_UPLOAD_PROGRESS);
  const [uploadKind, setUploadKind] = useState<UploadKind>('image');
  const uploadProgress = useMemo(() => ({ ...progress, kind: uploadKind }), [progress, uploadKind]);
  const activeUploadTaskIdRef = useRef<number | null>(null);
  const uploadTaskIdCounterRef = useRef<number>(0);
  const uploadTimeoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hostWaiterRef = useRef<HostWaiter | null>(null);
  const streamUploadRef = useRef<PendingStreamUpload | null>(null);
  // Read inside the callbacks the host's pulls call back, which outlive renders.
  const streamSupportedRef = useRef(pasteStreamSupported);
  streamSupportedRef.current = pasteStreamSupported;

  const clearUploadTimer = useCallback(() => {
    if (uploadTimeoutTimerRef.current) {
      clearTimeout(uploadTimeoutTimerRef.current);
      uploadTimeoutTimerRef.current = null;
    }
  }, []);

  const settleHostWaiter = useCallback((ok: boolean) => {
    hostWaiterRef.current?.resolve(ok);
    hostWaiterRef.current = null;
  }, []);

  const settleStreamUpload = useCallback((ok: boolean) => {
    streamUploadRef.current?.resolve(ok);
    streamUploadRef.current = null;
  }, []);

  const resetUploadProgress = useCallback(() => {
    clearUploadTimer();
    settleHostWaiter(false);
    settleStreamUpload(false);
    activeUploadTaskIdRef.current = null;
    setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
  }, [clearUploadTimer, settleHostWaiter, settleStreamUpload]);

  /** A relay error ends any upload in flight; the error itself is toasted elsewhere. */
  const abortUpload = useCallback(() => {
    if (activeUploadTaskIdRef.current !== null) resetUploadProgress();
  }, [resetUploadProgress]);

  /** The completed flash, guarded so a stale one cannot wipe a newer upload. */
  const flashCompleted = useCallback((taskId: number, statusText: string) => {
    setUploadProgress({
      active: true,
      phase: 'completed' as const,
      ratio: 1.0,
      percent: 100,
      statusText,
    });
    setTimeout(() => {
      if (activeUploadTaskIdRef.current === taskId) {
        activeUploadTaskIdRef.current = null;
        setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
      }
    }, UPLOAD_DONE_LINGER_MS);
  }, []);

  const giveUp = useCallback(
    (message?: string) => {
      if (message) addToast('error', message);
      resetUploadProgress();
      return false;
    },
    [addToast, resetUploadProgress],
  );

  /**
   * The stall watchdog: armed after every message exchanged, so a silent
   * workstation fails the upload while any answer rate at all keeps it alive.
   * That is what lets an upload of any size outlast a fixed total budget.
   */
  const armStallTimer = useCallback(
    (taskId: number) => {
      clearUploadTimer();
      uploadTimeoutTimerRef.current = setTimeout(() => {
        if (activeUploadTaskIdRef.current === taskId) {
          giveUp(t('serverErrors.paste_file_write_failed'));
        }
      }, UPLOAD_STALL_TIMEOUT_MS);
    },
    [clearUploadTimer, giveUp, t],
  );

  /** The workstation saved the file: resolve its waiter, flash it if not quiet. */
  const completeUpload = useCallback(
    (requestId?: string) => {
      const currentTaskId = activeUploadTaskIdRef.current;
      const stream = streamUploadRef.current;
      if (stream && stream.taskId === currentTaskId && stream.requestId === requestId) {
        streamUploadRef.current = null;
        clearUploadTimer();
        stream.resolve(true);
        if (!stream.quiet && currentTaskId !== null) {
          flashCompleted(currentTaskId, t('virtualKeyboard.uploadProgressCompleted'));
        }
        return;
      }
      const waiter = hostWaiterRef.current;
      if (currentTaskId === null || !waiter || waiter.taskId !== currentTaskId) return;
      hostWaiterRef.current = null;
      clearUploadTimer();
      waiter.resolve(true);
      if (!waiter.quiet)
        flashCompleted(currentTaskId, t('virtualKeyboard.uploadProgressCompleted'));
    },
    [clearUploadTimer, flashCompleted, t],
  );

  /**
   * The workstation pulls one slice: read just those bytes — a prepared image
   * from memory, a file straight off the picker's blob — and send them back.
   * Slices the upload did not announce, or for an upload already gone, do not
   * get answered.
   */
  const handleUploadChunkRequest = useCallback(
    async (requestId: string, index: number): Promise<void> => {
      const up = streamUploadRef.current;
      if (
        !up ||
        up.requestId !== requestId ||
        activeUploadTaskIdRef.current !== up.taskId ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= up.totalChunks
      ) {
        return;
      }
      const adapter = adapterRef.current;
      if (!adapter) return;
      const offset = index * PASTE_CHUNK_BYTES;
      let bytes: Uint8Array;
      try {
        bytes =
          up.source instanceof Uint8Array
            ? up.source.subarray(offset, offset + PASTE_CHUNK_BYTES)
            : await readBlobSlice(up.source, index);
      } catch (err) {
        console.error('Failed to read upload slice:', err);
        if (activeUploadTaskIdRef.current === up.taskId) {
          up.resolve(false);
          streamUploadRef.current = null;
          giveUp(t('clipboard.fileReadFailed'));
        }
        return;
      }
      // The read may have outlived the upload: a timeout or disconnect wins.
      if (streamUploadRef.current !== up || activeUploadTaskIdRef.current !== up.taskId) return;
      adapter.sendPasteFileChunk(requestId, index, encodeBase64(bytes));
      up.sent += 1;
      const sentAll = up.sent >= up.totalChunks;
      const ratio = sentAll ? 0.92 : Math.min(0.85, 0.3 + (up.sent / up.totalChunks) * 0.55);
      setUploadProgress({
        active: true,
        phase: sentAll ? 'waitingHost' : 'sending',
        ratio,
        percent: Math.round(ratio * 100),
        statusText:
          t(
            sentAll
              ? 'virtualKeyboard.uploadProgressWaitingHost'
              : 'virtualKeyboard.uploadProgressSending',
          ) + up.suffix,
      });
      armStallTimer(up.taskId);
    },
    [adapterRef, armStallTimer, giveUp, t],
  );

  useEffect(() => {
    if (connectionState !== 'connected') abortUpload();
  }, [connectionState, abortUpload]);

  useEffect(() => clearUploadTimer, [clearUploadTimer]);

  /** Claims the one upload slot this window has, or says why it cannot. */
  const beginUpload = useCallback(
    (kind: UploadKind): number | null => {
      if (role !== 'controller') {
        warnViewerMode();
        return null;
      }
      if (!adapterRef.current || connectionState !== 'connected') {
        addToast('error', t('serverErrors.host_offline'));
        return null;
      }
      if (activeUploadTaskIdRef.current !== null) return null;
      const taskId = ++uploadTaskIdCounterRef.current;
      activeUploadTaskIdRef.current = taskId;
      setUploadKind(kind);
      clearUploadTimer();
      return taskId;
    },
    [adapterRef, role, connectionState, warnViewerMode, addToast, t, clearUploadTimer],
  );

  /** The one-shot transport: the whole payload in one message, resolving on ready. */
  const sendWholeAndAwaitHost = useCallback(
    (
      taskId: number,
      mime: string,
      dataBase64: string,
      name: string | undefined,
      quiet: boolean,
      suffix: string,
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        setUploadProgress({
          active: true,
          phase: 'sending',
          ratio: 0.75,
          percent: 75,
          statusText: t('virtualKeyboard.uploadProgressSending') + suffix,
        });

        const sent = sendPasteFile(mime, dataBase64, name);
        if (activeUploadTaskIdRef.current !== taskId) return resolve(false);
        if (!sent) {
          giveUp();
          return resolve(false);
        }

        setUploadProgress({
          active: true,
          phase: 'waitingHost',
          ratio: 0.88,
          percent: 88,
          statusText: t('virtualKeyboard.uploadProgressWaitingHost') + suffix,
        });

        settleHostWaiter(false);
        hostWaiterRef.current = { taskId, resolve, quiet };
        armStallTimer(taskId);
      });
    },
    [t, sendPasteFile, giveUp, settleHostWaiter, armStallTimer],
  );

  /**
   * The chunked transport: announce the upload, then idle until the host pulls
   * a slice. `paste_file_ready` for this request id resolves it.
   */
  const streamAndAwaitHost = useCallback(
    (
      taskId: number,
      mime: string,
      source: Uint8Array | Blob,
      name: string | undefined,
      quiet: boolean,
      suffix: string,
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const adapter = adapterRef.current;
        if (!adapter || activeUploadTaskIdRef.current !== taskId) return resolve(false);
        const size = source instanceof Uint8Array ? source.length : source.size;
        const streamUpload: PendingStreamUpload = {
          taskId,
          requestId: newFsRequestId(),
          resolve,
          quiet,
          suffix,
          source,
          size,
          totalChunks: Math.max(1, Math.ceil(size / PASTE_CHUNK_BYTES)),
          sent: 0,
        };
        streamUploadRef.current = streamUpload;
        setUploadProgress({
          active: true,
          phase: 'sending',
          ratio: 0.3,
          percent: 30,
          statusText: t('virtualKeyboard.uploadProgressSending') + suffix,
        });
        adapter.sendPasteFileBegin(streamUpload.requestId, mime, size, name);
        armStallTimer(taskId);
      });
    },
    [adapterRef, armStallTimer, t],
  );

  return {
    uploadProgress,
    activeUploadTaskIdRef,
    streamSupportedRef,
    setUploadProgress,
    beginUpload,
    sendWholeAndAwaitHost,
    streamAndAwaitHost,
    handleUploadChunkRequest,
    completeUpload,
    flashCompleted,
    resetUploadProgress,
    abortUpload,
  };
}
