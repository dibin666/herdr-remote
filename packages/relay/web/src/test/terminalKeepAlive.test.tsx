import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { App } from '../App';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;

const ADMIN_STATUS_FIXTURE = {
  version: '0.1.0',
  uptimeSeconds: 100,
  startTime: new Date().toISOString(),
  serverTime: new Date().toISOString(),
  activeControllerId: 'client-1',
  activeHostId: 'host-1',
  clients: [],
  hosts: [],
  ptys: [],
  throughput: {
    bytesIn: 0,
    bytesOut: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    framesIn: 0,
    framesOut: 0,
    framesInPerSec: 0,
    framesOutPerSec: 0,
  },
  cpu: { load1m: 0, load5m: 0, load15m: 0, cpuPercent: 0, cores: 2 },
  memory: { rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 1000 },
  eventLoopDelay: { p50Ms: 1, p99Ms: 2, maxMs: 3 },
  cleanup: {
    staleClientsPurged: 0,
    closedPtysCleaned: 0,
    deadConnectionsClosed: 0,
    idleHostsTerminated: 0,
  },
  protocolVersion: 1,
};

const goToAdmin = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Admin$/i }));
const goToTerminal = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));

describe('Terminal keep-alive across view navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    window.history.pushState({}, '', '/');
    // A stored token skips the onboarding view so the terminal layer mounts.
    saveSettings({ token: 'test-token-keepalive' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ADMIN_STATUS_FIXTURE),
    }) as unknown as typeof fetch;
  });

  it('does not construct or dispose the xterm instance when switching Terminal -> Admin -> Terminal', async () => {
    render(<App />);

    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    expect(term.disposed).toBe(false);

    await act(async () => {
      goToAdmin();
    });
    expect(await screen.findByText(/System Administration/i)).toBeInTheDocument();

    // The single terminal instance survives: not disposed, not rebuilt.
    expect(xtermInstances.length).toBe(1);
    expect(term.disposed).toBe(false);
    expect(term.dispose).not.toHaveBeenCalled();

    await act(async () => {
      goToTerminal();
    });

    expect(xtermInstances.length).toBe(1);
    expect(xtermInstances[0]).toBe(term);
    expect(term.disposed).toBe(false);
  });

  it('keeps the hidden terminal layer mounted and measurable (never display:none)', async () => {
    render(<App />);

    await waitFor(() => expect(xtermInstances.length).toBe(1));

    const layerWhileActive = screen.getByTestId('terminal-layer');
    expect(layerWhileActive.style.visibility).toBe('visible');
    expect(layerWhileActive.style.pointerEvents).toBe('auto');

    await act(async () => {
      goToAdmin();
    });

    const hiddenLayer = screen.getByTestId('terminal-layer');
    // Still in the tree, still laid out — only visually hidden.
    expect(hiddenLayer).toBeInTheDocument();
    expect(hiddenLayer.style.display).not.toBe('none');
    expect(hiddenLayer.style.visibility).toBe('hidden');
    expect(hiddenLayer.className).toContain('inset-0');
    expect(document.querySelector('#terminal-container')).toBeInTheDocument();

    // The inactive layer must not swallow clicks meant for the admin view.
    expect(hiddenLayer.style.pointerEvents).toBe('none');
    expect(hiddenLayer.getAttribute('aria-hidden')).toBe('true');

    const adminLayer = screen.getByTestId('admin-layer');
    expect(adminLayer.className).toContain('z-20');
  });

  it('re-measures and repaints the terminal when the view becomes active again', async () => {
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    await act(async () => {
      goToAdmin();
    });

    const refreshesBefore = term.refreshCount;

    await act(async () => {
      goToTerminal();
      // Let the restore path's bounded rAF fit run.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(term.refreshCount).toBeGreaterThan(refreshesBefore);
  });

  it('keeps the desktop terminal box unscaled and full-size across the round trip', async () => {
    // jsdom reports a desktop-width viewport, so the fit takes the unscaled
    // branch: no CSS scale is left on the surface and the layout boxes still
    // fill the layer, rather than keeping a stale mobile footprint.
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const surface = document.querySelector('#terminal-surface') as HTMLElement;
    const frame = document.querySelector('#terminal-frame') as HTMLElement;
    const before = {
      surfaceWidth: surface.style.width,
      surfaceHeight: surface.style.height,
      frameWidth: frame.style.width,
      frameHeight: frame.style.height,
    };
    expect(before).toEqual({
      surfaceWidth: '100%',
      surfaceHeight: '100%',
      frameWidth: '100%',
      frameHeight: '100%',
    });

    const term = xtermInstances[0];
    const gridBefore = { cols: term.cols, rows: term.rows };
    const resizesBefore = term.resizeCalls.length;

    await act(async () => {
      goToAdmin();
    });
    await act(async () => {
      goToTerminal();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Same element (never remounted) and the same geometry it had before.
    expect(document.querySelector('#terminal-surface')).toBe(surface);
    expect(surface.style.transform).toBe('none');
    expect({
      surfaceWidth: surface.style.width,
      surfaceHeight: surface.style.height,
      frameWidth: frame.style.width,
      frameHeight: frame.style.height,
    }).toEqual(before);

    // Re-measured on the way back, and to the same grid — an unchanged
    // viewport must not produce a spurious PTY resize.
    expect({ cols: term.cols, rows: term.rows }).toEqual(gridBefore);
    expect(term.resizeCalls.length).toBe(resizesBefore);
  });

  it('restores desktop keyboard focus after returning from Admin', async () => {
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    await act(async () => {
      goToAdmin();
    });
    const focusesBefore = term.focusCount;

    await act(async () => {
      goToTerminal();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // jsdom reports a desktop-width viewport, so focus is restored.
    expect(term.focusCount).toBeGreaterThan(focusesBefore);
  });
});
