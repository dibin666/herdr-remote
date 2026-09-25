import { useEffect, useRef } from 'react';
import { useTerminal } from '../context/TerminalContext';
import type { ServerAgentStatusMessage } from '../types/protocol';
import {
  attentionCounts,
  attentionLevel,
  newAttention,
  type AttentionLevel,
} from './agentAttention';
import { applyFaviconBadge } from './faviconBadge';
import { armAlertChime, playAlertChime } from './alertChime';

/**
 * However many agents change state at once, one alert in this window is all a
 * person gets; the title and icon carry the rest.
 */
export const AGENT_ALERT_COLLAPSE_MS = 15000;

const VIBRATION: Record<AttentionLevel, number[]> = {
  blocked: [70, 50, 70],
  done: [40],
};

/**
 * Tells a person when an agent on the workstation stops to ask or finishes.
 *
 * The tab's icon carries a dot while anything is waiting (the title's count is
 * written by TerminalView, which owns `document.title`). The alerts proper are
 * each opt-in, fire only on a change, and collapse: at most one per
 * AGENT_ALERT_COLLAPSE_MS, never queued, and never a toast.
 *
 * - vibration, only while the page is in view — browsers ignore it otherwise;
 * - a chime, only while the page is not in view, where a vibration cannot go;
 * - a system notification, only on HTTPS: over the LAN's plain HTTP the API
 *   does not exist, which is why none of the rest depends on it.
 */
export function useAgentAlerts(): void {
  const { agentStatus, settings, t } = useTerminal();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tRef = useRef(t);
  tRef.current = t;
  const previousRef = useRef<ServerAgentStatusMessage | null>(null);
  const lastAlertAtRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    applyFaviconBadge(
      settings.agentAlertBadge ? attentionLevel(attentionCounts(agentStatus)) : null,
    );
  }, [agentStatus, settings.agentAlertBadge]);

  useEffect(() => () => applyFaviconBadge(null), []);

  useEffect(() => {
    if (!settings.agentAlertSound || typeof window === 'undefined') return undefined;
    return armAlertChime(window);
  }, [settings.agentAlertSound]);

  useEffect(() => {
    // A disconnect clears the status to null, so the first report after a
    // reconnect is compared against nothing and stays silent.
    const previous = previousRef.current;
    previousRef.current = agentStatus;
    const level = newAttention(previous, agentStatus);
    if (!level) return;

    const now = Date.now();
    if (now - lastAlertAtRef.current < AGENT_ALERT_COLLAPSE_MS) return;
    lastAlertAtRef.current = now;

    const current = settingsRef.current;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const unfocused = hidden || (typeof document !== 'undefined' && !document.hasFocus());

    if (
      current.agentAlertVibrate &&
      !hidden &&
      typeof navigator !== 'undefined' &&
      navigator.vibrate
    ) {
      try {
        navigator.vibrate(VIBRATION[level]);
      } catch {
        // Vibration refused before any user gesture; nothing to do.
      }
    }
    if (current.agentAlertSound && unfocused) {
      playAlertChime(level);
    }
    if (
      current.agentAlertNotify &&
      hidden &&
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      const counts = attentionCounts(agentStatus)!;
      const body =
        level === 'blocked'
          ? tRef.current('agents.notifyBlocked', { count: counts.blocked })
          : tRef.current('agents.notifyDone', { count: counts.done });
      try {
        new Notification('Herdr Remote', { body, tag: 'herdr-agents' });
      } catch {
        // Some mobile browsers only allow notifications from a service worker.
      }
    }
  }, [agentStatus]);
}
