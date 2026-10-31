// The file list dialog: what the terminal's working directory holds, sorted
// the way the window asks, with the picked entries pulled down as one file or
// a zip.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FsListEntry } from '@protocol/files';
import { useConnection, useSettings } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { Button, Gauge, Modal, Spinner } from '@/shared/ui';
import type { TranslationKey } from '@/shared/i18n';
import { formatByteSize } from '@/features/paste/imagePaste';
import { isCoarsePointerDevice } from '@/features/terminal/terminalLayout';
import { type FileMenuAction, FileContextMenu } from './FileContextMenu';
import { DeleteDialog, PropertiesDialog, RenameDialog } from './FileDialogs';
import { FilePreviewModal, type PreviewView } from './FilePreviewModal';
import {
  formatFsTime,
  type FsSortDir,
  type FsSortKey,
  parentDirOf,
  saveBlobAs,
  sortFsEntries,
} from './fileList';
import { FsRequestError, useHostFiles } from './useHostFiles';

const FS_ERROR_KEYS: Record<string, TranslationKey | undefined> = {
  fs_unsupported: 'files.errors.unsupported',
  fs_list_failed: 'files.errors.listFailed',
  fs_download_failed: 'files.errors.downloadFailed',
  fs_not_found: 'files.errors.notFound',
  fs_too_large: 'files.errors.tooLarge',
  fs_download_unavailable: 'files.errors.unavailable',
  fs_timeout: 'files.errors.timeout',
  fs_not_text: 'files.errors.notText',
  fs_exists: 'files.errors.exists',
  fs_preview_failed: 'files.errors.previewFailed',
  fs_rename_failed: 'files.errors.renameFailed',
  fs_delete_failed: 'files.errors.deleteFailed',
  disconnected: 'files.errors.disconnected',
};

function fsErrorText(error: unknown, t: (key: TranslationKey) => string): string {
  if (error instanceof FsRequestError) {
    const key = FS_ERROR_KEYS[error.code];
    return key ? t(key) : error.message || t('files.errors.failed');
  }
  return error instanceof Error && error.message ? error.message : t('files.errors.failed');
}

type ListView =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; cwd: string; entries: FsListEntry[] };

export function FileListModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useSettings();
  const { adapter } = useConnection();
  // Dir rows enter on one tap where double tap is not a thing.
  const coarse = isCoarsePointerDevice();
  const { listFiles, downloadFiles, previewFile, renameEntry, deleteEntry } = useHostFiles(adapter);

  const [view, setView] = useState<ListView>({ state: 'loading' });
  const [sortKey, setSortKey] = useState<FsSortKey>('name');
  const [sortDir, setSortDir] = useState<FsSortDir>('asc');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsListEntry } | null>(null);
  const [preview, setPreview] = useState<{ name: string; view: PreviewView } | null>(null);
  const [renaming, setRenaming] = useState<FsListEntry | null>(null);
  const [deleting, setDeleting] = useState<FsListEntry | null>(null);
  const [propsOf, setPropsOf] = useState<FsListEntry | null>(null);
  const [mutating, setMutating] = useState(false);
  const touchRef = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  /**
   * `dir` moves relative to the shown listing — `'.'` re-reads it, `'..'` its
   * parent, a name the directory it lists. Without one the terminal's own
   * directory is resolved again: how the dialog opens, and how it retries.
   */
  const navigate = useCallback(
    async (dir?: string) => {
      setView({ state: 'loading' });
      setSelected(new Set());
      setMenu(null);
      try {
        const result = await listFiles(dir);
        setView({ state: 'ready', cwd: result.cwd, entries: result.entries });
      } catch (error) {
        setView({ state: 'error', message: fsErrorText(error, t) });
      }
    },
    [listFiles, t],
  );

  useEffect(() => {
    if (isOpen) void navigate();
  }, [isOpen, navigate]);

  const sorted = useMemo(
    () => (view.state === 'ready' ? sortFsEntries(view.entries, sortKey, sortDir) : []),
    [view, sortKey, sortDir],
  );

  const toggleSort = (key: FsSortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allSelected = sorted.length > 0 && selected.size === sorted.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sorted.map((entry) => entry.name)));
  };

  const startDownload = async (names: string[]) => {
    if (names.length === 0 || download) return;
    setDownload({ received: 0, total: 0 });
    try {
      const result = await downloadFiles(names, (received, total) =>
        setDownload({ received, total }),
      );
      saveBlobAs(result.name, result.blob);
      setSelected(new Set());
    } catch (error) {
      setView({ state: 'error', message: fsErrorText(error, t) });
    } finally {
      setDownload(null);
    }
  };

  const openMenu = (x: number, y: number, entry: FsListEntry) => setMenu({ x, y, entry });

  const onMenuAction = async (action: FileMenuAction) => {
    const entry = action.entry;
    setMenu(null);
    switch (action.kind) {
      case 'preview': {
        setPreview({ name: entry.name, view: { state: 'loading' } });
        try {
          const result = await previewFile(entry.name);
          setPreview({
            name: entry.name,
            view: { state: 'ready', text: result.text, truncated: result.truncated },
          });
        } catch (error) {
          setPreview({
            name: entry.name,
            view: { state: 'error', message: fsErrorText(error, t) },
          });
        }
        break;
      }
      case 'download':
        await startDownload([entry.name]);
        break;
      case 'rename':
        setRenaming(entry);
        break;
      case 'delete':
        setDeleting(entry);
        break;
      case 'properties':
        setPropsOf(entry);
        break;
    }
  };

  const submitRename = async (newName: string) => {
    const entry = renaming;
    if (!entry) return;
    setMutating(true);
    try {
      await renameEntry(entry.name, newName);
      setRenaming(null);
      await navigate('.');
    } catch (error) {
      setRenaming(null);
      setView({ state: 'error', message: fsErrorText(error, t) });
    } finally {
      setMutating(false);
    }
  };

  const submitDelete = async () => {
    const entry = deleting;
    if (!entry) return;
    setMutating(true);
    try {
      await deleteEntry(entry.name);
      setDeleting(null);
      await navigate('.');
    } catch (error) {
      setDeleting(null);
      setView({ state: 'error', message: fsErrorText(error, t) });
    } finally {
      setMutating(false);
    }
  };

  const sortMark = (key: FsSortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const sortAria = (key: FsSortKey) =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  const headerButton = (key: FsSortKey, label: string, alignRight = false) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={cn(
        'tui-focusable w-full select-none whitespace-nowrap text-tui-sm font-bold text-tui-muted hover:text-tui-accent',
        alignRight ? 'text-right' : 'text-left',
      )}
    >
      {label}
      {sortMark(key)}
    </button>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('files.title')}
      subtitle={view.state === 'ready' ? view.cwd : undefined}
      closeLabel={t('common.closeDialog')}
      size="lg"
      className="max-h-[75dvh] min-h-[10rem] sm:max-h-[85dvh] sm:min-h-[16rem]"
      footer={
        view.state === 'ready' ? (
          <>
            <Button
              onClick={() => void navigate('.')}
              disabled={Boolean(download)}
              title={t('files.refresh')}
            >
              {t('files.refresh')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void startDownload([...selected])}
              disabled={selected.size === 0 || Boolean(download)}
              data-testid="files-download"
            >
              {t('files.download', { count: selected.size })}
            </Button>
          </>
        ) : undefined
      }
    >
      {view.state === 'loading' ? (
        <div className="flex items-center justify-center gap-2 px-1 py-8 text-tui text-tui-faint">
          <Spinner />
          <span>{t('files.loading')}</span>
        </div>
      ) : view.state === 'error' ? (
        <div className="flex flex-col items-start gap-3 px-1 py-4">
          <p className="text-tui text-tui-bad" data-testid="files-error">
            {view.message}
          </p>
          <Button onClick={() => void navigate()}>{t('files.retry')}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {download ? (
            <Gauge
              ratio={download.total > 0 ? download.received / download.total : 0}
              label={t('files.downloading')}
              tone="accent"
              aria-label={t('files.downloading')}
            />
          ) : null}
          {sorted.length === 0 && !(view.state === 'ready' && parentDirOf(view.cwd)) ? (
            <div className="px-1 py-4 text-center text-tui text-tui-faint">{t('files.empty')}</div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse text-tui">
                <thead>
                  <tr className="border-b border-tui-border">
                    <th scope="col" className="w-[3ch] px-1 py-1 text-left">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          // Half the rows picked shows the in-between mark.
                          if (el) el.indeterminate = selected.size > 0 && !allSelected;
                        }}
                        onChange={toggleAll}
                        aria-label={t('files.selectAll')}
                        className="tui-focusable accent-tui-accent"
                        data-testid="files-select-all"
                      />
                    </th>
                    <th scope="col" className="px-2 py-1 text-left" aria-sort={sortAria('name')}>
                      {headerButton('name', t('files.colName'))}
                    </th>
                    <th
                      scope="col"
                      className="w-[10ch] px-2 py-1 text-right"
                      aria-sort={sortAria('size')}
                    >
                      {headerButton('size', t('files.colSize'), true)}
                    </th>
                    <th
                      scope="col"
                      className="hidden w-[18ch] px-2 py-1 text-right sm:table-cell"
                      aria-sort={sortAria('mtime')}
                    >
                      {headerButton('mtime', t('files.colModified'), true)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.state === 'ready' && parentDirOf(view.cwd) ? (
                    <tr
                      onClick={() => void navigate('..')}
                      className="cursor-pointer border-b border-tui-border-dim hover:bg-tui-selection"
                      title={t('files.parentDir')}
                      data-testid="files-parent"
                    >
                      <td className="px-1 py-1" />
                      <td className="px-2 py-1 text-tui-muted">../</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right text-tui-muted">—</td>
                      <td className="hidden whitespace-nowrap px-2 py-1 text-right text-tui-muted sm:table-cell">
                        —
                      </td>
                    </tr>
                  ) : null}
                  {sorted.map((entry) => {
                    const checked = selected.has(entry.name);
                    return (
                      <tr
                        key={entry.name}
                        onClick={() => {
                          // On a coarse pointer there is no reliable double tap: a
                          // dir opens on the first tap, selection goes through the
                          // row's checkbox. Desktop keeps click to pick, double
                          // click to enter.
                          if (entry.kind === 'dir' && coarse) void navigate(entry.name);
                          else toggle(entry.name);
                        }}
                        onDoubleClick={
                          entry.kind === 'dir' ? () => void navigate(entry.name) : undefined
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openMenu(e.clientX, e.clientY, entry);
                        }}
                        onTouchStart={(e) => {
                          const touch = e.touches[0];
                          touchRef.current = {
                            x: touch.clientX,
                            y: touch.clientY,
                            timer: setTimeout(
                              () => openMenu(touch.clientX, touch.clientY, entry),
                              500,
                            ),
                          };
                        }}
                        onTouchMove={(e) => {
                          const held = touchRef.current;
                          if (!held) return;
                          const touch = e.touches[0];
                          // A moved finger scrolls; it is not a long press.
                          if (Math.hypot(touch.clientX - held.x, touch.clientY - held.y) > 10) {
                            clearTimeout(held.timer);
                            touchRef.current = null;
                          }
                        }}
                        onTouchEnd={() => {
                          if (touchRef.current) clearTimeout(touchRef.current.timer);
                          touchRef.current = null;
                        }}
                        onTouchCancel={() => {
                          if (touchRef.current) clearTimeout(touchRef.current.timer);
                          touchRef.current = null;
                        }}
                        className={cn(
                          'cursor-pointer border-b border-tui-border-dim last:border-b-0 hover:bg-tui-selection',
                          checked && 'bg-tui-selection',
                        )}
                        data-selected={checked || undefined}
                      >
                        <td className="px-1 py-1 text-left text-tui-muted">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(entry.name)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={entry.name}
                            className="accent-tui-accent"
                          />
                        </td>
                        <td className="max-w-0 truncate px-2 py-1 text-tui-text" title={entry.name}>
                          {entry.name}
                          {entry.kind === 'dir' ? '/' : ''}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-right text-tui-muted">
                          {entry.kind === 'dir' ? '—' : formatByteSize(entry.size)}
                        </td>
                        <td className="hidden whitespace-nowrap px-2 py-1 text-right text-tui-muted sm:table-cell">
                          {formatFsTime(entry.mtimeMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {menu ? (
        <FileContextMenu
          entry={menu.entry}
          anchor={{ x: menu.x, y: menu.y }}
          onAction={(action) => void onMenuAction(action)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {preview ? (
        <FilePreviewModal
          name={preview.name}
          view={preview.view}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          entry={renaming}
          busy={mutating}
          onSubmit={(newName) => void submitRename(newName)}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          entry={deleting}
          busy={mutating}
          onConfirm={() => void submitDelete()}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {propsOf && view.state === 'ready' ? (
        <PropertiesDialog entry={propsOf} cwd={view.cwd} onClose={() => setPropsOf(null)} />
      ) : null}
    </Modal>
  );
}
