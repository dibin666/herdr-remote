// The right-click / long-press menu for one row of the file list: what a
// window may do with the entry under the finger. Rendered fixed at the
// pointer, clamped to the viewport; a transparent backdrop catches the
// click that dismisses it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FsListEntry } from '@protocol/files';
import { useSettings } from '@/context/TerminalContext';
import { isPreviewableName } from './fileList';

export interface FileMenuAction {
  kind: 'preview' | 'download' | 'rename' | 'delete' | 'properties';
  entry: FsListEntry;
}

interface Item {
  kind: FileMenuAction['kind'];
  label: string;
  danger?: boolean;
}

export function FileContextMenu({
  entry,
  anchor,
  onAction,
  onClose,
}: {
  entry: FsListEntry;
  anchor: { x: number; y: number };
  onAction: (action: FileMenuAction) => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  const items: Item[] = [
    ...(entry.kind === 'file' && isPreviewableName(entry.name)
      ? [{ kind: 'preview' as const, label: t('files.menuPreview') }]
      : []),
    { kind: 'download', label: t('files.menuDownload') },
    { kind: 'rename', label: t('files.menuRename') },
    { kind: 'delete', label: t('files.menuDelete'), danger: true },
    { kind: 'properties', label: t('files.menuProperties') },
  ];

  // The menu is measured once mounted, then clamped inside the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: its size follows the items, so measure again when they change
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const x = Math.min(
      Math.max(margin, anchor.x),
      Math.max(margin, innerWidth - rect.width - margin),
    );
    // Above the touch point first, the way the selection menu opens: a long
    // press ends under the finger, and a menu drawn below it would eat the
    // release click on its first item.
    let y = anchor.y - rect.height - 8;
    if (y < margin) y = anchor.y + 8;
    y = Math.max(margin, Math.min(y, Math.max(margin, innerHeight - rect.height - margin)));
    setCoords({ x, y });
  }, [anchor.x, anchor.y, entry.name]);

  // Down outside closes; Escape closes. `pointerdown` rather than `click`: a
  // long press ends its touch with a click on the row it opened over, which
  // must not tear the menu down the moment it appeared. A right click that
  // opened the menu preventDefaults, so it never counts as an outside one.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && !menuRef.current?.contains(e.target)) onClose();
    };
    const context = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.target instanceof Node && !menuRef.current?.contains(e.target)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('contextmenu', context);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('contextmenu', context);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={entry.name}
      className="fixed z-50 min-w-[10rem] select-none border border-tui-border bg-tui-base py-1 font-mono shadow-lg"
      style={{
        left: coords ? `${coords.x}px` : `${anchor.x}px`,
        top: coords ? `${coords.y}px` : `${anchor.y}px`,
        visibility: coords ? 'visible' : 'hidden',
      }}
    >
      <div className="truncate px-3 py-1 text-tui-sm text-tui-faint" title={entry.name}>
        {entry.name}
        {entry.kind === 'dir' ? '/' : ''}
      </div>
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          className={`tui-focusable block w-full px-3 py-1.5 text-left text-tui-sm ${
            item.danger
              ? 'text-tui-bad hover:bg-tui-bad hover:text-tui-crust'
              : 'text-tui-text hover:bg-tui-selection'
          }`}
          onClick={() => onAction({ kind: item.kind, entry })}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
