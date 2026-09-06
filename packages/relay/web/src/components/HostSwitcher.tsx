import React, { useEffect, useRef, useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { Button, GLYPH, StatusDot } from './tui';

interface HostSwitcherProps {
  onAddProfile: () => void;
  mobile?: boolean;
  /** Render the compact, touch-sized picker used by the phone status bar. */
  statusBar?: boolean;
}

/**
 * Browser-local host profile picker. The relay is never queried for this list:
 * it contains only pairings this browser explicitly saved, which is important
 * on a shared relay where enumerating hosts would be a tenant leak.
 */
export const HostSwitcher: React.FC<HostSwitcherProps> = ({
  onAddProfile,
  mobile = false,
  statusBar = false,
}) => {
  const {
    profiles,
    activeProfileId,
    activeProfile,
    connectionState,
    switchProfile,
    renameProfile,
    removeProfile,
    t,
  } = useTerminal();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const beginRename = (profileId: string, currentName: string) => {
    setEditingId(profileId);
    setNameDraft(currentName);
  };

  const commitRename = (profileId: string) => {
    const value = nameDraft.trim();
    if (value) renameProfile(profileId, value);
    setEditingId(null);
  };

  const remove = (profileId: string) => {
    if (typeof window !== 'undefined' && !window.confirm(t('profiles.removeConfirm'))) return;
    removeProfile(profileId);
    setEditingId(null);
  };

  const label = activeProfile?.displayName || t('profiles.addHost');
  const statusLevel = connectionState === 'connected'
    ? 'ok'
    : connectionState === 'connecting' || connectionState === 'reconnecting'
      ? 'warn'
      : connectionState === 'error'
        ? 'bad'
        : 'idle';

  return (
    <div ref={rootRef} className={cn('relative min-w-0', mobile && 'w-full', statusBar && 'flex-1')}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('profiles.switcherLabel')}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'tui-focusable flex min-w-0 items-center gap-1.5 border border-transparent text-left text-tui-muted transition-colors hover:border-tui-border hover:text-tui-accent',
          statusBar
            ? 'min-h-11 w-full max-w-none px-2'
            : mobile
              ? 'min-h-11 w-full px-2'
              : 'min-h-[24px] max-w-[18rem] px-1',
        )}
      >
        <StatusDot level={statusLevel} />
        <span className={cn('truncate text-tui-text', statusBar && 'min-w-0 flex-1')}>{label}</span>
        <span aria-hidden="true" className="shrink-0 text-tui-faint">{open ? GLYPH.chevronDown : GLYPH.chevronRight}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('profiles.switcherLabel')}
          className={cn(
            'absolute bottom-full left-0 z-[100] mb-1 max-h-[min(70vh,24rem)] overflow-y-auto border border-tui-border bg-tui-base p-1 shadow-lg',
            statusBar
              ? 'w-80 max-w-[calc(100vw-1rem)]'
              : mobile
                ? 'inset-x-0 bottom-auto top-full mt-1 mb-0 w-full'
                : 'w-80 max-w-[calc(100vw-1rem)]',
          )}
        >
          <div className="border-b border-tui-border-dim px-2 py-1 text-tui-sm uppercase text-tui-faint">
            {t('profiles.title')}
          </div>

          {profiles.length === 0 ? (
            <p className="px-2 py-2 text-tui-sm text-tui-muted">{t('profiles.empty')}</p>
          ) : (
            profiles.map((profile) => {
              const active = profile.id === activeProfileId;
              const editing = profile.id === editingId;
              return (
                <div key={profile.id} role="none" className="border-b border-tui-border-dim last:border-b-0">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      role="menuitem"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        switchProfile(profile.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'tui-focusable flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left text-tui transition-colors hover:bg-tui-selection',
                        active ? 'text-tui-accent' : 'text-tui-text',
                      )}
                    >
                      <span aria-hidden="true" className="w-3 shrink-0">{active ? GLYPH.cursor : ''}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold">{profile.displayName}</span>
                        <span className="block truncate text-tui-sm text-tui-faint" title={profile.hostname || profile.hostId}>
                          {profile.hostname || profile.hostId || profile.wsUrl}
                        </span>
                      </span>
                      {active && <span className="shrink-0 text-tui-sm text-tui-ok">{t('profiles.current')}</span>}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={t('profiles.rename')}
                      title={t('profiles.rename')}
                      onClick={() => beginRename(profile.id, profile.displayName)}
                      className="tui-focusable min-h-11 min-w-11 px-2 text-tui-muted hover:text-tui-accent"
                    >
                      {GLYPH.ellipsis}
                    </button>
                  </div>

                  {editing && (
                    <div className="flex items-center gap-1 px-2 pb-2">
                      <input
                        autoFocus
                        value={nameDraft}
                        maxLength={64}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename(profile.id);
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        aria-label={t('profiles.rename')}
                        className="tui-input min-w-0 flex-1 px-2 py-1 text-tui"
                      />
                      <Button onClick={() => commitRename(profile.id)} variant="primary" className="min-h-11">
                        {t('common.save')}
                      </Button>
                      <Button onClick={() => remove(profile.id)} variant="danger" className="min-h-11">
                        {t('profiles.remove')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddProfile();
            }}
            className="tui-focusable flex min-h-11 w-full items-center gap-2 px-2 text-left text-tui-accent hover:bg-tui-selection"
          >
            <span aria-hidden="true">+</span>
            <span>{t('profiles.addHost')}</span>
          </button>
        </div>
      )}
    </div>
  );
};
