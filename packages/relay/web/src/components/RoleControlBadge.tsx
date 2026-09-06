import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { Row, StatusDot } from './tui';

/**
 * What this window may do, and who else is looking at the same screen.
 *
 * There is no control lease any more. Every window paired to a workstation is a
 * view of one shared terminal with full input, so the question this line used to
 * answer — "may I type?" — has one answer, and the question worth answering
 * instead is how many other windows are watching what you type. A number is the
 * whole story, so it is told as a line of text with a dot in front of it rather
 * than as a control the user has to operate.
 */
export const RoleControlBadge: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { role, connectionState, sharedWindowCount, assignedClientId, t } = useTerminal();

  const isConnected = connectionState === 'connected';

  if (!isConnected) {
    return (
      <div
        className="inline-flex select-none items-center gap-1.5 text-tui uppercase text-tui-faint"
        role="status"
        aria-label={t('terminal.offlineStatusAria')}
      >
        <StatusDot level="idle" />
        <span>{t('common.offline')}</span>
      </div>
    );
  }

  // The server hands every paired window the controller role; anything else is
  // an older relay, and saying so is more honest than pretending otherwise.
  const canType = role === 'controller';
  const shared = sharedWindowCount > 1;

  const summary = (
    <div
      className={cn(
        'inline-flex min-w-0 select-none items-center gap-1.5 text-tui uppercase',
        canType ? 'text-tui-ok' : 'text-tui-warn'
      )}
      role="status"
      aria-label={canType ? t('role.controllerMode') : t('role.viewerMode')}
    >
      <StatusDot level={canType ? 'ok' : 'warn'} />
      <span className="truncate">
        {canType ? t('role.sharedControl') : t('role.viewerReadOnly')}
      </span>
      {shared ? (
        <span className="shrink-0 normal-case text-tui-muted">
          {t('role.sharedWindows', { count: sharedWindowCount })}
        </span>
      ) : null}
    </div>
  );

  if (compact) return summary;

  return (
    <div className="flex w-full flex-col gap-1">
      {summary}
      <p className="text-tui-sm leading-snug text-tui-faint">{t('role.sharedControlDesc')}</p>
      {assignedClientId ? (
        <Row label={t('role.thisWindow')} labelWidth={9} className="text-tui-sm">
          <span className="truncate text-tui-muted">{assignedClientId}</span>
        </Row>
      ) : null}
    </div>
  );
};
