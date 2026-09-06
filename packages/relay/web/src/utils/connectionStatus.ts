/**
 * One description of the session state, shared by the mobile chrome trigger and
 * the control sheet so a collapsed shell and its expanded sheet can never
 * disagree about whether the terminal is live.
 */

import { ConnectionState } from '../types/protocol';

export interface ConnectionDescriptor {
  /** Short label for the collapsed pill. */
  label: string;
  /** Tailwind classes for the status dot. */
  dotClass: string;
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
        dotClass: 'bg-emerald-500',
        needsAttention: false,
      };
    case 'connecting':
      return {
        label: tr('connection.connecting', 'Connecting'),
        dotClass: 'bg-amber-500 animate-pulse',
        needsAttention: true,
      };
    case 'reconnecting':
      return {
        label: tr('connection.reconnecting', 'Reconnecting'),
        dotClass: 'bg-amber-500 animate-pulse',
        needsAttention: true,
        actionLabel: tr('connection.reconnectNow', 'Reconnect now'),
      };
    case 'error':
      return {
        label: tr('connection.error', 'Error'),
        dotClass: 'bg-red-500',
        needsAttention: true,
        actionLabel: tr('connection.retry', 'Retry'),
      };
    default:
      return {
        label: tr('connection.offline', 'Offline'),
        dotClass: 'bg-charcoal-400',
        needsAttention: true,
        actionLabel: tr('connection.connect', 'Connect'),
      };
  }
}
