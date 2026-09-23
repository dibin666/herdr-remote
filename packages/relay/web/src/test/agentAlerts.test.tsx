import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { useAgentAlerts, AGENT_ALERT_COLLAPSE_MS } from '../utils/useAgentAlerts';
import { saveSettings } from '../utils/storage';

/**
 * Alerts are opt-in, fire on a change and never on the first report, collapse
 * to one per window, and never raise a toast: a notification per state change
 * is the flood the status chip was built to replace.
 */
const Harness: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({ onReady }) => {
  onReady(useTerminal());
  useAgentAlerts();
  return null;
};

function mount() {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Harness onReady={(value) => { ctx = value; }} />
    </TerminalProvider>,
  );
  const push = (statuses: Record<string, string>) => {
    const agents = Object.entries(statuses).map(([paneId, status]) => ({
      paneId, workspaceId: 'w', agent: 'claude', title: null, status, focused: false,
    }));
    const counts: Record<string, number> = {};
    for (const status of Object.values(statuses)) counts[status] = (counts[status] ?? 0) + 1;
    // @ts-expect-error test mock
    act(() => { ctx?.adapter?.emit('agentStatus', { type: 'agent_status', counts, total: agents.length, agents }); });
  };
  return { push, get toasts() { return ctx?.toasts ?? []; } };
}

describe('Agent alerts', () => {
  let vibrate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent on the first report, then vibrates once for an agent that needs you', () => {
    saveSettings({ agentAlertVibrate: true });
    const alerts = mount();
    alerts.push({ p1: 'blocked', p2: 'working' });
    expect(vibrate).not.toHaveBeenCalled();

    alerts.push({ p1: 'blocked', p2: 'done' });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([40]);
    expect(alerts.toasts).toHaveLength(0);
  });

  it(`collapses a run of changes into one alert per ${AGENT_ALERT_COLLAPSE_MS / 1000} seconds`, () => {
    saveSettings({ agentAlertVibrate: true });
    const alerts = mount();
    alerts.push({ p1: 'working', p2: 'working', p3: 'working' });
    alerts.push({ p1: 'blocked', p2: 'working', p3: 'working' });
    alerts.push({ p1: 'blocked', p2: 'done', p3: 'working' });
    alerts.push({ p1: 'blocked', p2: 'done', p3: 'blocked' });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([70, 50, 70]);

    vi.setSystemTime(Date.now() + AGENT_ALERT_COLLAPSE_MS);
    alerts.push({ p1: 'done', p2: 'done', p3: 'blocked' });
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(alerts.toasts).toHaveLength(0);
  });

  it('does nothing when the alerts are off, which is the default', () => {
    const alerts = mount();
    alerts.push({ p1: 'working' });
    alerts.push({ p1: 'blocked' });
    expect(vibrate).not.toHaveBeenCalled();
    expect(alerts.toasts).toHaveLength(0);
  });

  it('does not vibrate a page that is not on screen', () => {
    saveSettings({ agentAlertVibrate: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const alerts = mount();
    alerts.push({ p1: 'working' });
    alerts.push({ p1: 'blocked' });
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('badges the tab icon while something is waiting', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    document.head.appendChild(link);
    try {
      const alerts = mount();
      alerts.push({ p1: 'blocked' });
      expect(link.getAttribute('href')).toContain('%23f9e2af');
      alerts.push({ p1: 'working' });
      expect(link.getAttribute('href')).not.toContain('<circle');
    } finally {
      link.remove();
    }
  });
});
