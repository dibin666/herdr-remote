import type React from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { describeConnection } from '@/connection/connectionStatus';
import { Segments, StatusDot, StatusLine } from '@/shared/ui';
import { AgentStatusChip, agentStatusHasContent } from '@/features/agents/AgentStatusChip';
import { HostSwitcher } from '@/features/pairing/HostSwitcher';
import { ControlModeBadge } from './ControlModeBadge';
import { UpdateChip, useUpdateNoticeVisible } from './UpdateNotice';
import { cn } from '@/shared/lib/cn';

const FIXED = 'shrink-0 whitespace-nowrap';
const GIVES_WAY = 'min-w-0 truncate whitespace-nowrap';

interface SessionStatusLineProps {
  onAddProfile?: () => void;
}

/**
 * The status area shared by every desktop view.
 *
 * It deliberately is not a banner and it is not a collection of cards. Herdr's
 * TUI keeps facts about the current session on one compact line at the bottom:
 * connection state, role, host, client and latency. The content view above can
 * then be a terminal, a wizard, or an admin screen without changing the shell
 * around it.
 */
export const SessionStatusLine: React.FC<SessionStatusLineProps> = ({
  onAddProfile = () => {},
}) => {
  const { settings, t } = useSettings();
  const { connectionState, hostId, assignedClientId, sharedWindowCount, rttMs, agentStatus } =
    useConnection();
  const status = describeConnection(connectionState, t);
  const connected = connectionState === 'connected';
  const updateVisible = useUpdateNoticeVisible();

  return (
    <StatusLine
      left={
        <>
          <HostSwitcher onAddProfile={onAddProfile} />
          {/* One row: no segment may wrap. The state and the role keep their
              width; the long host and client ids are what truncate. */}
          <Segments
            data-testid="status-line-segments"
            items={[
              <span key="status" className={cn(FIXED, 'flex items-center gap-1')}>
                <StatusDot level={status.level} />
                <span className="text-tui-text">{status.label}</span>
              </span>,
              // Nothing is being controlled while the session is down, so the
              // line says nothing about it rather than claiming a role that has
              // no session to apply to.
              connected ? <ControlModeBadge key="role" className={FIXED} /> : null,
              connected && sharedWindowCount > 1 ? (
                <span key="windows" className={cn(FIXED, 'text-tui-muted')}>
                  {t('role.sharedWindows', { count: sharedWindowCount })}
                </span>
              ) : null,
              /* Once the session is up, the ids are reference material, not
                 live state: one segment keeps the host name and the full ids
                 are a hover away, instead of two long strings pushing the
                 latency off the line. Before it connects, the client id is
                 all the identity there is, so it keeps its own segment. */
              hostId ? (
                <span
                  key="host"
                  className={GIVES_WAY}
                  title={`${t('common.host')}: ${hostId} · ${t('header.clientIdLabel')} ${assignedClientId || settings.clientId}`}
                >
                  <span className="text-tui-faint">{t('common.host')}:</span>{' '}
                  <span className="text-tui-text">{hostId}</span>
                </span>
              ) : (
                <span key="client" className={GIVES_WAY}>
                  <span className="text-tui-faint">{t('header.clientIdLabel')}</span>{' '}
                  <span className="text-tui-text">{assignedClientId || settings.clientId}</span>
                </span>
              ),
            ]}
          />
        </>
      }
      right={
        <Segments
          data-testid="status-line-right"
          items={[
            updateVisible ? <UpdateChip key="update" /> : null,
            connected && agentStatusHasContent(agentStatus) ? (
              <AgentStatusChip key="agents" />
            ) : null,
            rttMs !== null ? (
              <span key="rtt" className="text-tui-muted">
                {t('header.latencyTitle')}: <span className="text-tui-text">{rttMs}ms</span>
              </span>
            ) : null,
          ]}
        />
      }
    />
  );
};
