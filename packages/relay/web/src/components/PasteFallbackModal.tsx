/**
 * Fallback modal for manual clipboard pasting.
 *
 * Why this is necessary:
 *
 * 1. Insecure Contexts (plain HTTP on LAN):
 *    In insecure contexts (e.g. http://192.168.x.x), `navigator.clipboard.read()` and `readText()`
 *    are stripped by browser security models. Synchronous `execCommand('paste')` has been
 *    permanently disabled for unprivileged scripts across all browsers. The only way to read
 *    clipboard text is through a focused native textarea where the user long-presses and pastes.
 *
 * 2. Mobile Keyboard Image Paste Limitations:
 *    Mobile keyboards (Gboard, iOS keyboard) do NOT reliably emit clipboardData image items to web
 *    textareas, and Chrome often displays "Chrome does not support pasting images here". Therefore,
 *    mobile image entry relies primarily on explicit file inputs (<input type="file" accept="image/*">),
 *    offering both photo album and camera ("capture") entry points.
 *
 * 3. Best-Effort Image Paste:
 *    When a desktop browser or secure browser does emit image data inside a clipboard paste event,
 *    the textarea's onPaste handler intercepts the event, extracts the image Blob, and compresses it.
 *
 * 4. Content Security Policy (CSP):
 *    Thumbnail previews MUST be rendered using `data:` URLs (via `PreparedImagePaste.dataUrl`),
 *    never `blob:` URLs, because the relay's CSP header restricts images to `img-src 'self' data:`.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Modal, Button } from './tui';
import { useTerminal } from '../context/TerminalContext';
import {
  extractImageFromClipboardEvent,
  extractImageFromFileList,
} from '../utils/clipboard';
import {
  compressAndPrepareImage,
  formatByteSize,
  PreparedImagePaste,
} from '../utils/imagePaste';

export interface PasteFallbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  onSendImage?: (image: PreparedImagePaste) => void;
}

export const PasteFallbackModal: React.FC<PasteFallbackModalProps> = ({
  isOpen,
  onClose,
  onSend,
  onSendImage,
}) => {
  const { t, addToast } = useTerminal();
  const [textValue, setTextValue] = useState('');
  const [imageState, setImageState] = useState<PreparedImagePaste | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset inputs whenever the modal is opened
  useEffect(() => {
    if (isOpen) {
      setTextValue('');
      setImageState(null);
      setIsCompressing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }, [isOpen]);

  const processImageBlob = async (blob: Blob) => {
    if (blob.size === 0) {
      addToast('error', t('clipboard.fileEmpty'));
      return;
    }
    setIsCompressing(true);
    try {
      const prepared = await compressAndPrepareImage(blob);
      if (prepared) {
        setImageState(prepared);
        setTextValue('');
      } else {
        addToast('error', t('clipboard.imageTooLarge'));
      }
    } catch (err) {
      console.error('Failed to process image:', err);
      addToast('error', t('clipboard.imageTooLarge'));
    } finally {
      setIsCompressing(false);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageBlob = extractImageFromClipboardEvent(e);
    if (imageBlob) {
      // Intercept image paste (e.g. desktop Ctrl+V) so raw binary or HTML is not dumped into textarea
      e.preventDefault();
      await processImageBlob(imageBlob);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = extractImageFromFileList(e.target.files);
    // Reset file input so re-selecting the same file triggers change again
    e.target.value = '';
    if (!file) return;
    await processImageBlob(file);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setTextValue(val);
    if (val && imageState) {
      setImageState(null);
    }
  };

  const handleClearImage = () => {
    setImageState(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  const handleSend = () => {
    if (imageState) {
      onSendImage?.(imageState);
      onClose();
    } else if (textValue.trim()) {
      onSend(textValue);
      onClose();
    }
  };

  const hasContent = Boolean(textValue.trim() || imageState);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('clipboard.pasteTitle')}
      closeLabel={t('clipboard.cancel')}
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('clipboard.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!hasContent || isCompressing}
          >
            {t('clipboard.pasteSend')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-3 font-mono select-text">
        {/* Text Section */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="paste-fallback-input" className="text-tui-sm text-tui-muted font-sans font-medium">
            {t('clipboard.pasteHint')}
          </label>
          <textarea
            ref={textareaRef}
            id="paste-fallback-input"
            data-testid="paste-fallback-input"
            rows={4}
            autoFocus
            placeholder={t('clipboard.pasteHint')}
            value={textValue}
            onChange={handleTextChange}
            onPaste={handlePaste}
            disabled={Boolean(imageState) || isCompressing}
            className="tui-input min-h-[90px] w-full resize-none p-2 text-tui font-mono rounded border border-tui-border bg-tui-bg focus:outline-none focus:ring-1 focus:ring-tui-accent disabled:opacity-50"
          />
        </div>

        {/* Visual separator between Text and Image entry */}
        <div className="relative my-1">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-tui-border" />
          </div>
          <div className="relative flex justify-center text-tui-xs uppercase">
            <span className="bg-tui-bg px-2 text-tui-muted font-sans">
              {t('clipboard.imageSectionTitle')}
            </span>
          </div>
        </div>

        {/* Image Section */}
        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/*"
            className="hidden"
            data-testid="paste-fallback-file-input"
            onChange={handleFileChange}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/*"
            capture="environment"
            className="hidden"
            data-testid="paste-fallback-camera-input"
            onChange={handleFileChange}
          />

          {imageState ? (
            <div className="flex flex-col items-center gap-2 p-3 border border-tui-border bg-tui-bg rounded">
              {/* Thumbnail preview MUST use data: URL to satisfy CSP (img-src 'self' data:) */}
              <img
                src={imageState.dataUrl}
                alt="Pasted preview"
                data-testid="pasted-image-preview"
                className="max-h-40 max-w-full object-contain rounded border border-tui-border"
              />
              <div className="flex items-center justify-between w-full text-tui-xs text-tui-muted pt-1">
                <span>{t('clipboard.imageCompressedSize', { size: formatByteSize(imageState.byteLength) })}</span>
                <Button
                  variant="ghost"
                  onClick={handleClearImage}
                  aria-label={t('clipboard.removeImage')}
                >
                  {t('clipboard.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="default"
                onClick={() => fileInputRef.current?.click()}
                disabled={isCompressing || Boolean(textValue.trim())}
                className="min-h-[44px] px-3 touch-manipulation text-tui-sm font-sans flex-1"
                aria-label={t('clipboard.chooseImage')}
              >
                {t('clipboard.chooseImage')}
              </Button>
              <Button
                variant="default"
                onClick={() => cameraInputRef.current?.click()}
                disabled={isCompressing || Boolean(textValue.trim())}
                className="min-h-[44px] px-3 touch-manipulation text-tui-sm font-sans flex-1"
                aria-label={t('clipboard.takePhoto')}
              >
                {t('clipboard.takePhoto')}
              </Button>
            </div>
          )}

          {isCompressing && (
            <div className="flex items-center gap-2 text-tui-xs text-tui-muted animate-pulse">
              <span>{t('clipboard.imageCompressing')}</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
