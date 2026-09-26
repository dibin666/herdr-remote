// Sending an image from the key bar: the hidden file pickers, the button that
// opens one, and the gauge shown while the upload runs.

import type React from 'react';
import type { RefObject } from 'react';
import { useConnection, useSettings, useTerminalIO, useUpload } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { Gauge } from '@/shared/ui';
import { CAP_BASE, CAP_IDLE } from './caps';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/*';

export function UploadFileInputs({
  fileInputRef,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { uploadImage } = useUpload();
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    uploadImage(file);
  };
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        data-testid="key-toolbar-file-input"
        onChange={handleFileInputChange}
      />
      <input
        type="file"
        accept={IMAGE_ACCEPT}
        capture="environment"
        className="hidden"
        data-testid="key-toolbar-camera-input"
        onChange={handleFileInputChange}
      />
    </>
  );
}

export function UploadProgressBar({ collapsed }: { collapsed: boolean }) {
  const { uploadProgress } = useUpload();
  if (!uploadProgress.active) return null;
  return (
    <div
      data-testid={collapsed ? 'key-toolbar-progress-collapsed' : 'key-toolbar-progress'}
      className="w-full border-b border-tui-border-dim bg-tui-crust px-2 py-1"
    >
      <Gauge
        ratio={uploadProgress.ratio}
        label={uploadProgress.statusText}
        tone={
          uploadProgress.phase === 'completed'
            ? 'ok'
            : uploadProgress.phase === 'error'
              ? 'bad'
              : 'accent'
        }
        aria-label={uploadProgress.statusText}
      />
    </div>
  );
}

export function ImageUploadButton({
  fileInputRef,
  keyClass,
  vibrate,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  keyClass: string;
  vibrate: () => void;
}) {
  const { t } = useSettings();
  const { isController } = useConnection();
  const { warnViewerMode } = useTerminalIO();
  const { uploadProgress } = useUpload();
  const isUploading = uploadProgress.active;

  const handleImageClick = () => {
    vibrate();
    if (!isController) {
      warnViewerMode();
      return;
    }
    if (isUploading) {
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <button
      type="button"
      data-testid="image-upload-btn"
      onClick={handleImageClick}
      disabled={isUploading}
      className={cn(
        CAP_BASE,
        keyClass,
        isUploading
          ? 'border-tui-border-dim bg-tui-surface opacity-60 cursor-not-allowed'
          : CAP_IDLE,
      )}
      title={isUploading ? uploadProgress.statusText : t('virtualKeyboard.uploadImageTitle')}
      aria-label={t('virtualKeyboard.uploadImage')}
    >
      <span className="font-medium">
        {isUploading ? `${uploadProgress.percent}%` : t('virtualKeyboard.image')}
      </span>
    </button>
  );
}
