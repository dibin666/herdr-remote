// Sending pasted images, or any files, to the workstation, with progress for
// the key bar. One file at a time crosses the socket: a picked batch is a
// queue on top of the same single-file pipeline, each file waiting for the
// host's answer before the next one is read.

import type { ClientRole } from '@protocol/messages';
import { PASTE_FILE_MIME, PASTE_MAX_BYTES } from '@protocol/paste';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translate } from '@/shared/i18n';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import type { ConnectionState } from '@/connection/types';
import {
  compressAndPrepareImage,
  IDLE_IMAGE_UPLOAD_PROGRESS,
  type ImageUploadProgress,
  type PreparedImagePaste,
  type UploadKind,
} from '@/features/paste/imagePaste';
import type { ToastItem } from './useToastQueue';

/** How long the workstation may take to confirm it saved the file. */
const UPLOAD_CONFIRM_TIMEOUT_MS = 30_000;
/** How long "completed" stays on the progress bar. */
const UPLOAD_DONE_LINGER_MS = 1200;

/** What the host's `paste_file_ready` resolves: the file it just confirmed. */
interface HostWaiter {
  taskId: number;
  resolve: (ok: boolean) => void;
  /** Part of a batch: the batch shows its own progress, not the flash. */
  quiet: boolean;
}

export function useImageUpload({
  adapterRef,
  role,
  connectionState,
  warnViewerMode,
  addToast,
  t,
  sendPasteFile,
}: {
  adapterRef: RefObject<HerdrClientAdapter | null>;
  role: ClientRole;
  connectionState: ConnectionState;
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

  const resetUploadProgress = useCallback(() => {
    clearUploadTimer();
    settleHostWaiter(false);
    activeUploadTaskIdRef.current = null;
    setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
  }, [clearUploadTimer, settleHostWaiter]);

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

  /** The workstation saved the file: resolve its waiter, flash it if not quiet. */
  const completeUpload = useCallback(() => {
    const currentTaskId = activeUploadTaskIdRef.current;
    const waiter = hostWaiterRef.current;
    if (currentTaskId === null || !waiter || waiter.taskId !== currentTaskId) return;
    hostWaiterRef.current = null;
    clearUploadTimer();
    waiter.resolve(true);
    if (!waiter.quiet) flashCompleted(currentTaskId, t('virtualKeyboard.uploadProgressCompleted'));
  }, [clearUploadTimer, flashCompleted, t]);

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

  const giveUp = useCallback(
    (message?: string) => {
      if (message) addToast('error', message);
      resetUploadProgress();
      return false;
    },
    [addToast, resetUploadProgress],
  );

  /** Sends the payload, resolving once the host says it saved the file. */
  const sendAndAwaitHost = useCallback(
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
        uploadTimeoutTimerRef.current = setTimeout(() => {
          if (activeUploadTaskIdRef.current === taskId) {
            giveUp(t('serverErrors.paste_file_write_failed'));
          }
        }, UPLOAD_CONFIRM_TIMEOUT_MS);
      });
    },
    [t, sendPasteFile, giveUp, settleHostWaiter],
  );

  const uploadOneImage = useCallback(
    async (
      taskId: number,
      input: Blob | File | PreparedImagePaste,
      quiet: boolean,
      suffix: string,
    ): Promise<boolean> => {
      const isPrepared =
        'dataBase64' in input && typeof (input as PreparedImagePaste).dataBase64 === 'string';

      try {
        let prepared: PreparedImagePaste;

        if (isPrepared) {
          prepared = input as PreparedImagePaste;
        } else {
          const blob = input as Blob | File;
          setUploadProgress({
            active: true,
            phase: 'reading',
            ratio: 0.1,
            percent: 10,
            statusText: t('virtualKeyboard.uploadProgressReading') + suffix,
          });

          if (!blob || blob.size === 0) {
            addToast('error', t('clipboard.fileEmpty'));
            return false;
          }
          if (blob.type && !blob.type.startsWith('image/')) {
            addToast('error', t('clipboard.unsupportedType'));
            return false;
          }

          setUploadProgress({
            active: true,
            phase: 'processing',
            ratio: 0.35,
            percent: 35,
            statusText: t('virtualKeyboard.uploadProgressProcessing') + suffix,
          });

          const res = await compressAndPrepareImage(blob);
          if (activeUploadTaskIdRef.current !== taskId) {
            return false;
          }
          if (!res) {
            addToast('error', t('clipboard.imageTooLarge'));
            return false;
          }

          prepared = res;
          setUploadProgress({
            active: true,
            phase: 'processing',
            ratio: 0.6,
            percent: 60,
            statusText: t('virtualKeyboard.uploadProgressProcessing') + suffix,
          });
        }

        return await sendAndAwaitHost(
          taskId,
          prepared.mime,
          prepared.dataBase64,
          undefined,
          quiet,
          suffix,
        );
      } catch (err) {
        console.error('Failed to process/upload image:', err);
        if (activeUploadTaskIdRef.current === taskId) {
          addToast('error', t('clipboard.imageTooLarge'));
        }
        return false;
      }
    },
    [sendAndAwaitHost, addToast, t],
  );

  const uploadOneFile = useCallback(
    async (taskId: number, file: File, quiet: boolean, suffix: string): Promise<boolean> => {
      // Checked before reading: a file over the cap is refused, never shrunk.
      if (file.size === 0) {
        addToast('error', t('clipboard.fileEmpty'));
        return false;
      }
      if (file.size > PASTE_MAX_BYTES) {
        addToast('error', t('clipboard.fileTooLarge'));
        return false;
      }

      setUploadProgress({
        active: true,
        phase: 'reading',
        ratio: 0.3,
        percent: 30,
        statusText: t('virtualKeyboard.uploadProgressReading') + suffix,
      });
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });
        if (activeUploadTaskIdRef.current !== taskId) return false;
        const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        return await sendAndAwaitHost(
          taskId,
          PASTE_FILE_MIME,
          dataBase64,
          file.name,
          quiet,
          suffix,
        );
      } catch (err) {
        console.error('Failed to read file for upload:', err);
        if (activeUploadTaskIdRef.current === taskId) {
          addToast('error', t('clipboard.fileReadFailed'));
        }
        return false;
      }
    },
    [sendAndAwaitHost, addToast, t],
  );

  /**
   * A batch is the single-file pipeline run back to back under one task id.
   * A refused file (empty, oversized, unsupported) is toasted and skipped; a
   * failed send ends the batch, because the reason it failed — an error, a
   * disconnect — is not one file's fault.
   */
  const runBatch = useCallback(
    async (kind: UploadKind, items: (Blob | File | PreparedImagePaste)[]): Promise<boolean> => {
      const queue = items.filter(Boolean);
      if (queue.length === 0) return false;
      const taskId = beginUpload(kind);
      if (taskId === null) return false;

      const multi = queue.length > 1;
      let done = 0;
      for (let i = 0; i < queue.length; i++) {
        if (activeUploadTaskIdRef.current !== taskId) return done > 0;
        const suffix = multi ? ` (${i + 1}/${queue.length})` : '';
        const item = queue[i];
        const ok =
          kind === 'image'
            ? await uploadOneImage(taskId, item, multi, suffix)
            : await uploadOneFile(taskId, item as File, multi, suffix);
        if (activeUploadTaskIdRef.current !== taskId) return done > 0;
        if (ok) done++;
      }

      if (done === 0) {
        activeUploadTaskIdRef.current = null;
        setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
        return false;
      }
      // A single file's flash came from completeUpload; a batch shows its own.
      if (multi) {
        flashCompleted(
          taskId,
          `${t('virtualKeyboard.uploadProgressCompleted')} (${done}/${queue.length})`,
        );
      }
      return true;
    },
    [beginUpload, uploadOneImage, uploadOneFile, flashCompleted, t],
  );

  const uploadImage = useCallback(
    (input: Blob | File | PreparedImagePaste): Promise<boolean> => runBatch('image', [input]),
    [runBatch],
  );

  const uploadFile = useCallback(
    (file: File): Promise<boolean> => runBatch('file', [file]),
    [runBatch],
  );

  const uploadImages = useCallback(
    (files: (Blob | File)[]): Promise<boolean> => runBatch('image', files),
    [runBatch],
  );

  const uploadFiles = useCallback(
    (files: File[]): Promise<boolean> => runBatch('file', files),
    [runBatch],
  );

  return {
    uploadProgress,
    uploadImage,
    uploadFile,
    uploadImages,
    uploadFiles,
    resetUploadProgress,
    abortUpload,
    completeUpload,
  };
}
