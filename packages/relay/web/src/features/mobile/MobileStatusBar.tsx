import type React from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { AgentInbox } from '@/features/agents/AgentInbox';
import { HostSwitcher } from '@/features/pairing/HostSwitcher';
import { UpdateChip } from '@/features/status/UpdateNotice';

interface MobileStatusBarProps {
  onAddProfile: () => void;
  onOpenMenu: () => void;
  menuOpen: boolean;
}

/**
 * The phone's only chrome: a compact, thumb-high dock bar. Switching hosts,
 * answering a waiting agent and opening the menu are the three things a phone
 * needs while watching a terminal, and all of them are on this row — the
 * terminal keeps the rest of the screen.
 */
export const MobileStatusBar: React.FC<MobileStatusBarProps> = ({
  onAddProfile,
  onOpenMenu,
  menuOpen,
}) => {
  const { t } = useSettings();
  const { rttMs, isController } = useConnection();

  return (
    <footer
      data-testid="mobile-status-bar"
      role="status"
      aria-label={t('mobile.statusBarAria')}
      className="absolute inset-x-0 bottom-0 z-40 flex h-11 shrink-0 items-center gap-2 border-t border-tui-border bg-tui-mantle px-1 text-tui-sm"
    >
      <HostSwitcher statusBar onAddProfile={onAddProfile} />
      <span aria-hidden="true" className="shrink-0 text-tui-border">
        │
      </span>
      {/*
        Between the host and the latency, because "is anything waiting on me?"
        is why a phone is looking at this bar at all. It renders nothing until
        the workstation reports, so the row's spacing is unchanged when there is
        nothing to say.
      */}
      <AgentInbox compact />
      <UpdateChip compact />
      {!isController && (
        <span className="shrink-0 px-1 font-bold uppercase text-tui-warn">
          {t('common.viewer')}
        </span>
      )}
      <span
        className="flex shrink-0 items-center gap-1 px-1 text-tui-muted"
        title={t('header.latencyTitle')}
      >
        <span className="text-tui-faint">RTT</span>
        <span className={cn(rttMs === null ? 'text-tui-faint' : 'text-tui-text')}>
          {rttMs === null ? '—' : `${rttMs}ms`}
        </span>
      </span>
      <button
        type="button"
        data-testid="mobile-chrome-trigger"
        onClick={onOpenMenu}
        aria-label={t('mobile.sessionControls')}
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        className="tui-focusable ml-auto flex h-9 shrink-0 select-none items-center gap-1.5 border border-tui-border px-2 text-tui uppercase text-tui-muted transition-colors hover:border-tui-accent hover:text-tui-accent"
      >
        <span aria-hidden="true" className="text-tui">
          ☰
        </span>
        <span aria-hidden="true">{t('mobile.menu')}</span>
      </button>
    </footer>
  );
};
