// Sending an image or any file from the key bar: the hidden file pickers, the
// buttons that open them, and the gauge shown while the upload runs.

import type React from 'react';
import type { RefObject } from 'react';
import { useConnection, useSettings, useTerminalIO, useUpload } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { Gauge } from '@/shared/ui';
import { CAP_BASE, CAP_IDLE } from './caps';
import { KeyIcon } from './KeyLabel';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/*';

export function UploadFileInputs({
  fileInputRef,
  anyFileInputRef,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  anyFileInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { uploadImage, uploadFile } = useUpload();
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    uploadImage(file);
  };
  const handleAnyFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    uploadFile(file);
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
      <input
        ref={anyFileInputRef}
        type="file"
        className="hidden"
        data-testid="key-toolbar-any-file-input"
        onChange={handleAnyFileInputChange}
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

const UPLOAD_BUTTONS = {
  image: {
    testId: 'image-upload-btn',
    icon: 'image',
    label: 'virtualKeyboard.uploadImage',
    title: 'virtualKeyboard.uploadImageTitle',
  },
  file: {
    testId: 'file-upload-btn',
    icon: 'attach',
    label: 'virtualKeyboard.uploadFile',
    title: 'virtualKeyboard.uploadFileTitle',
  },
} as const;

export function UploadButton({
  kind,
  inputRef,
  keyClass,
  squareKeyClass,
  vibrate,
}: {
  kind: keyof typeof UPLOAD_BUTTONS;
  inputRef: RefObject<HTMLInputElement | null>;
  keyClass: string;
  squareKeyClass: string;
  vibrate: () => void;
}) {
  const { t } = useSettings();
  const { isController } = useConnection();
  const { warnViewerMode } = useTerminalIO();
  const { uploadProgress } = useUpload();
  const isUploading = uploadProgress.active;
  const showsProgress = isUploading && (uploadProgress.kind ?? 'image') === kind;
  const button = UPLOAD_BUTTONS[kind];

  const handleClick = () => {
    vibrate();
    if (!isController) {
      warnViewerMode();
      return;
    }
    if (isUploading) {
      return;
    }
    inputRef.current?.click();
  };

  return (
    <button
      type="button"
      data-testid={button.testId}
      onClick={handleClick}
      disabled={isUploading}
      className={cn(
        CAP_BASE,
        // Square while it is an icon; the percentage needs a word's width.
        showsProgress ? keyClass : squareKeyClass,
        isUploading
          ? 'border-tui-border-dim bg-tui-surface opacity-60 cursor-not-allowed'
          : CAP_IDLE,
      )}
      title={isUploading ? uploadProgress.statusText : t(button.title)}
      aria-label={t(button.label)}
    >
      {showsProgress ? <span>{`${uploadProgress.percent}%`}</span> : <KeyIcon name={button.icon} />}
    </button>
  );
}
