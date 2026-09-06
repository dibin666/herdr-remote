import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { describeConnection } from '../utils/connectionStatus';
import { Badge, Segments, StatusDot, StatusLine } from './tui';

/**
 * The status area shared by every desktop view.
 *
 * It deliberately is not a banner and it is not a collection of cards. Herdr's
 * TUI keeps facts about the current session on one compact line at the bottom:
 * connection state, role, host, client and latency. The content view above can
 * then be a terminal, a wizard, or an admin screen without changing the shell
 * around it.
 */
export const SessionStatusLine: React.FC = () => {
  const {
    connectionState,
    role,
    hostId,
    assignedClientId,
    sharedWindowCount,
    settings,
    rttMs,
    t,
  } = useTerminal();
  const status = describeConnection(connectionState, t);
  const connected = connectionState === 'connected';

  return (
    <StatusLine
      left={
        <Segments
          items={[
            <span key="status" className="flex items-center gap-1">
              <StatusDot level={status.level} />
              <span className="text-tui-text">{status.label}</span>
            </span>,
            // Nothing is being controlled while the session is down, so the
            // line says nothing about it rather than claiming a role that has
            // no session to apply to.
            connected ? (
              <Badge key="role" tone={role === 'controller' ? 'ok' : 'warn'}>
                {role === 'controller' ? t('role.sharedControl') : t('common.viewer')}
              </Badge>
            ) : null,
            connected && sharedWindowCount > 1 ? (
              <span key="windows" className="text-tui-muted">
                {t('role.sharedWindows', { count: sharedWindowCount })}
              </span>
            ) : null,
            hostId ? (
              <span key="host">
                <span className="text-tui-faint">{t('common.host')}:</span>{' '}
                <span className="text-tui-text">{hostId}</span>
              </span>
            ) : null,
            <span key="client">
              <span className="text-tui-faint">{t('header.clientIdLabel')}</span>{' '}
              <span className="text-tui-text">{assignedClientId || settings.clientId}</span>
            </span>,
          ]}
        />
      }
      right={
        <Segments
          items={[
            rttMs !== null ? (
              <span key="rtt" className="text-tui-muted">
                {t('header.latencyTitle')}: <span className="text-tui-text">{rttMs}ms</span>
              </span>
            ) : null,
            <span key="mode" className="hidden text-tui-faint sm:inline">
              {t('header.tagline')}
            </span>,
          ]}
        />
      }
    />
  );
};
