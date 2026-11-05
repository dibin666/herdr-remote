// Sending pasted images, or any files, to the workstation, with progress for
// the key bar. One file at a time crosses the socket: a picked batch is a
// queue on top of the same single-file pipeline, each file waiting for the
// host's answer before the next one is read.
//
// The transports themselves — claiming the upload slot, the stall watchdog,
// and answering the workstation's slice pulls — live in useUploadTransport;
// this is the preparation and batching on top of it.

import type { ClientRole } from '@protocol/messages';
import { PASTE_FILE_MIME, PASTE_MAX_BYTES } from '@protocol/paste';
import type { RefObject } from 'react';
import { useCallback } from 'react';
import type { Translate } from '@/shared/i18n';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import type { ConnectionState } from '@/connection/types';
import { decodeBase64 } from '@/features/hostFont/hostFont';
import {
  compressAndPrepareImage,
  IDLE_IMAGE_UPLOAD_PROGRESS,
  type PreparedImagePaste,
  type UploadKind,
} from '@/features/paste/imagePaste';
import { useUploadTransport } from './useUploadTransport';
import type { ToastItem } from './useToastQueue';

export function useImageUpload({
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
  const {
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
  } = useUploadTransport({
    adapterRef,
    role,
    connectionState,
    pasteStreamSupported,
    warnViewerMode,
    addToast,
    t,
    sendPasteFile,
  });

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

        if (streamSupportedRef.current) {
          // The host pulls slices, so the payload leaves memory as bytes.
          return await streamAndAwaitHost(
            taskId,
            prepared.mime,
            decodeBase64(prepared.dataBase64),
            undefined,
            quiet,
            suffix,
          );
        }
        return await sendWholeAndAwaitHost(
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
    [
      streamAndAwaitHost,
      sendWholeAndAwaitHost,
      setUploadProgress,
      activeUploadTaskIdRef,
      streamSupportedRef,
      addToast,
      t,
    ],
  );

  const uploadOneFile = useCallback(
    async (taskId: number, file: File, quiet: boolean, suffix: string): Promise<boolean> => {
      // Checked before anything is read: an empty file is refused either way.
      if (file.size === 0) {
        addToast('error', t('clipboard.fileEmpty'));
        return false;
      }
      if (streamSupportedRef.current) {
        // No size cap and no whole-file read: the host pulls slices on demand.
        return await streamAndAwaitHost(taskId, PASTE_FILE_MIME, file, file.name, quiet, suffix);
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
        return await sendWholeAndAwaitHost(
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
    [
      streamAndAwaitHost,
      sendWholeAndAwaitHost,
      setUploadProgress,
      activeUploadTaskIdRef,
      streamSupportedRef,
      addToast,
      t,
    ],
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
    [
      beginUpload,
      uploadOneImage,
      uploadOneFile,
      activeUploadTaskIdRef,
      setUploadProgress,
      flashCompleted,
      t,
    ],
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
    handleUploadChunkRequest,
  };
}
