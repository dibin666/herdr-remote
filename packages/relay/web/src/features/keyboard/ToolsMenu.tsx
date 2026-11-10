// The desktop's terminal-input tools, one popover on the status line.
//
// On a fine-pointer device the touch key bar is off by default, so the
// actions that used to live at its tail — paste, uploads, the file list —
// need a home that is not a key cap. This is it: one word on the status line
// opening a small menu above it, plus the switch that brings the key bar
// back for whoever wants it.

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useSettings, useTerminalIO } from '@/context/TerminalContext';
import { FileListModal } from '@/features/files/FileListModal';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { KeyIcon } from './KeyLabel';
import { UploadFileInputs } from './UploadControls';

const rowClass =
  'tui-focusable group flex h-9 w-full select-none items-center gap-2 px-2 text-left text-tui transition-colors hover:bg-tui-selection hover:text-tui-accent';

const ToolRow: React.FC<{
  icon: 'paste' | 'image' | 'attach' | 'folder' | 'customize';
  label: string;
  aside?: React.ReactNode;
  onClick: () => void;
}> = ({ icon, label, aside, onClick }) => (
  <button type="button" className={rowClass} onClick={onClick}>
    <span aria-hidden="true" className="text-tui-faint group-hover:text-tui-accent">
      <KeyIcon name={icon} />
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {aside ? <span className="shrink-0 text-tui-sm text-tui-faint">{aside}</span> : null}
  </button>
);

export const ToolsMenu: React.FC = () => {
  const { settings, updateSettings, t } = useSettings();
  const { isController } = useConnection();
  const { sendKey, warnViewerMode } = useTerminalIO();
  const [open, setOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const anyFileInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    if (!isController) {
      warnViewerMode();
      return;
    }
    setOpen(false);
    action();
  };

  return (
    <span ref={rootRef} className="relative inline-flex items-center">
      <UploadFileInputs fileInputRef={fileInputRef} anyFileInputRef={anyFileInputRef} />
      <button
        type="button"
        data-testid="tools-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="tui-focusable select-none whitespace-nowrap text-tui-muted hover:text-tui-accent"
      >
        {t('tools.label')} ▴
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('tools.label')}
          data-testid="tools-menu"
          className="absolute bottom-full right-0 z-[100] mb-1 w-64 max-w-[calc(100vw-1rem)] border border-tui-border bg-tui-base p-1 shadow-lg"
        >
          <ToolRow
            icon="paste"
            label={t('clipboard.paste')}
            onClick={pick(() => setPasteOpen(true))}
          />
          <ToolRow
            icon="image"
            label={t('virtualKeyboard.uploadImage')}
            onClick={pick(() => fileInputRef.current?.click())}
          />
          <ToolRow
            icon="attach"
            label={t('virtualKeyboard.uploadFile')}
            onClick={pick(() => anyFileInputRef.current?.click())}
          />
          <ToolRow
            icon="folder"
            label={t('virtualKeyboard.fileList')}
            onClick={pick(() => setFilesOpen(true))}
          />
          <div aria-hidden="true" className="mx-1 my-1 h-px bg-tui-border-dim" />
          <ToolRow
            icon="customize"
            label={t('settings.touchKeyToolbar')}
            aside={
              <span className={settings.toolbarVisible ? 'text-tui-ok' : 'text-tui-faint'}>
                {settings.toolbarVisible ? t('settings.toggleOn') : t('settings.toggleOff')}
              </span>
            }
            onClick={() => {
              updateSettings({ toolbarVisible: !settings.toolbarVisible });
              setOpen(false);
            }}
          />
        </div>
      )}

      <PasteFallbackModal
        isOpen={pasteOpen}
        allowImage={false}
        onClose={() => setPasteOpen(false)}
        onSend={(text) => sendKey(text)}
      />
      <FileListModal isOpen={filesOpen} onClose={() => setFilesOpen(false)} />
    </span>
  );
};
