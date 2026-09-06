/**
 * One description of the session state, shared by the mobile chrome trigger and
 * the control sheet so a collapsed shell and its expanded sheet can never
 * disagree about whether the terminal is live.
 */

import { ConnectionState } from '../types/protocol';

export interface ConnectionDescriptor {
  /** Short label for the collapsed status line. */
  label: string;
  /** Status glyph level: `●` in a colour, or `○` for a session that is not up. */
  level: 'ok' | 'warn' | 'bad' | 'idle';
  /** True while the session is not carrying live output. */
  needsAttention: boolean;
  /** Label for the recovery button, or undefined when there is nothing to do. */
  actionLabel?: string;
}

export function describeConnection(
  state: ConnectionState,
  t?: (key: string, params?: Record<string, string | number>) => string
): ConnectionDescriptor {
  const tr = (key: string, fallback: string) => (t ? t(key) : fallback);

  switch (state) {
    case 'connected':
      return {
        label: tr('connection.live', 'Live'),
        level: 'ok',
        needsAttention: false,
      };
    case 'connecting':
      return {
        label: tr('connection.connecting', 'Connecting'),
        level: 'warn',
        needsAttention: true,
      };
    case 'reconnecting':
      return {
        label: tr('connection.reconnecting', 'Reconnecting'),
        level: 'warn',
        needsAttention: true,
        actionLabel: tr('connection.reconnectNow', 'Reconnect now'),
      };
    case 'error':
      return {
        label: tr('connection.error', 'Error'),
        level: 'bad',
        needsAttention: true,
        actionLabel: tr('connection.retry', 'Retry'),
      };
    default:
      return {
        label: tr('connection.offline', 'Offline'),
        level: 'idle',
        needsAttention: true,
        actionLabel: tr('connection.connect', 'Connect'),
      };
  }
}
