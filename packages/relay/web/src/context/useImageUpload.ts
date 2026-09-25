// Sending a pasted image to the workstation, with progress for the key bar.

import type { ClientRole } from '@protocol/messages';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Translate } from '../i18n';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import type { ConnectionState } from '../types/connection';
import {
  compressAndPrepareImage,
  IDLE_IMAGE_UPLOAD_PROGRESS,
  type ImageUploadProgress,
  type PreparedImagePaste,
} from '../utils/imagePaste';
import type { ToastItem } from './useToastQueue';

/** How long the workstation may take to confirm it saved the file. */
const UPLOAD_CONFIRM_TIMEOUT_MS = 30_000;
/** How long "completed" stays on the progress bar. */
const UPLOAD_DONE_LINGER_MS = 1200;

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
  sendPasteFile: (mime: string, dataBase64: string) => boolean;
}) {
  const [uploadProgress, setUploadProgress] = useState<ImageUploadProgress>(
    IDLE_IMAGE_UPLOAD_PROGRESS,
  );
  const activeUploadTaskIdRef = useRef<number | null>(null);
  const uploadTaskIdCounterRef = useRef<number>(0);
  const uploadTimeoutTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearUploadTimer = useCallback(() => {
    if (uploadTimeoutTimerRef.current) {
      clearTimeout(uploadTimeoutTimerRef.current);
      uploadTimeoutTimerRef.current = null;
    }
  }, []);

  const resetUploadProgress = useCallback(() => {
    clearUploadTimer();
    activeUploadTaskIdRef.current = null;
    setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
  }, [clearUploadTimer]);

  /** A relay error ends any upload in flight; the error itself is toasted elsewhere. */
  const abortUpload = useCallback(() => {
    if (activeUploadTaskIdRef.current !== null) resetUploadProgress();
  }, [resetUploadProgress]);

  /** The workstation saved the file: show it done, then clear the bar. */
  const completeUpload = useCallback(() => {
    const currentTaskId = activeUploadTaskIdRef.current;
    if (currentTaskId === null) return;
    clearUploadTimer();
    setUploadProgress({
      active: true,
      phase: 'completed' as const,
      ratio: 1.0,
      percent: 100,
      statusText: t('virtualKeyboard.uploadProgressCompleted'),
    });
    setTimeout(() => {
      if (activeUploadTaskIdRef.current === currentTaskId) {
        activeUploadTaskIdRef.current = null;
        setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
      }
    }, UPLOAD_DONE_LINGER_MS);
  }, [clearUploadTimer, t]);

  useEffect(() => {
    if (connectionState !== 'connected') abortUpload();
  }, [connectionState, abortUpload]);

  useEffect(() => clearUploadTimer, [clearUploadTimer]);

  const uploadImage = useCallback(
    async (input: Blob | File | PreparedImagePaste): Promise<boolean> => {
      if (role !== 'controller') {
        warnViewerMode();
        return false;
      }

      if (!adapterRef.current || connectionState !== 'connected') {
        addToast('error', t('serverErrors.host_offline'));
        return false;
      }

      if (activeUploadTaskIdRef.current !== null) {
        return false;
      }

      const taskId = ++uploadTaskIdCounterRef.current;
      activeUploadTaskIdRef.current = taskId;
      clearUploadTimer();

      const giveUp = (message?: string) => {
        if (message) addToast('error', message);
        activeUploadTaskIdRef.current = null;
        setUploadProgress(IDLE_IMAGE_UPLOAD_PROGRESS);
        return false;
      };

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
            statusText: t('virtualKeyboard.uploadProgressReading'),
          });

          if (!blob || blob.size === 0) return giveUp(t('clipboard.fileEmpty'));
          if (blob.type && !blob.type.startsWith('image/'))
            return giveUp(t('clipboard.unsupportedType'));

          setUploadProgress({
            active: true,
            phase: 'processing',
            ratio: 0.35,
            percent: 35,
            statusText: t('virtualKeyboard.uploadProgressProcessing'),
          });

          const res = await compressAndPrepareImage(blob);
          if (activeUploadTaskIdRef.current !== taskId) {
            return false;
          }
          if (!res) return giveUp(t('clipboard.imageTooLarge'));

          prepared = res;
          setUploadProgress({
            active: true,
            phase: 'processing',
            ratio: 0.6,
            percent: 60,
            statusText: t('virtualKeyboard.uploadProgressProcessing'),
          });
        }

        setUploadProgress({
          active: true,
          phase: 'sending',
          ratio: 0.75,
          percent: 75,
          statusText: t('virtualKeyboard.uploadProgressSending'),
        });

        const sent = sendPasteFile(prepared.mime, prepared.dataBase64);
        if (activeUploadTaskIdRef.current !== taskId) {
          return false;
        }
        if (!sent) return giveUp();

        setUploadProgress({
          active: true,
          phase: 'waitingHost',
          ratio: 0.88,
          percent: 88,
          statusText: t('virtualKeyboard.uploadProgressWaitingHost'),
        });

        uploadTimeoutTimerRef.current = setTimeout(() => {
          if (activeUploadTaskIdRef.current === taskId) {
            giveUp(t('serverErrors.paste_file_write_failed'));
          }
        }, UPLOAD_CONFIRM_TIMEOUT_MS);

        return true;
      } catch (err) {
        console.error('Failed to process/upload image:', err);
        if (activeUploadTaskIdRef.current === taskId) giveUp(t('clipboard.imageTooLarge'));
        return false;
      }
    },
    [
      adapterRef,
      role,
      connectionState,
      warnViewerMode,
      addToast,
      t,
      sendPasteFile,
      clearUploadTimer,
    ],
  );

  return { uploadProgress, uploadImage, resetUploadProgress, abortUpload, completeUpload };
}
