import type React from 'react';
import { useSettings, useConnection } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { AgentStatusChip } from './AgentStatusChip';
import { HostSwitcher } from './HostSwitcher';
import { UpdateChip } from './UpdateNotice';

interface MobileStatusBarProps {
  onAddProfile: () => void;
}

/**
 * The phone's only persistent navigation: a compact, touch-sized session bar.
 * Keep this intentionally smaller than the control sheet — switching hosts and
 * checking latency are the two actions needed while watching a terminal.
 */
export const MobileStatusBar: React.FC<MobileStatusBarProps> = ({ onAddProfile }) => {
  const { t } = useSettings();
  const { rttMs } = useConnection();

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
      <AgentStatusChip compact />
      <UpdateChip compact />
      <span
        className="flex shrink-0 items-center gap-1 px-1 text-tui-muted"
        title={t('header.latencyTitle')}
      >
        <span className="text-tui-faint">RTT</span>
        <span className={cn(rttMs === null ? 'text-tui-faint' : 'text-tui-text')}>
          {rttMs === null ? '—' : `${rttMs}ms`}
        </span>
      </span>
    </footer>
  );
};
