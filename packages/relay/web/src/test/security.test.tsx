import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { PairingModal } from '../components/PairingModal';
import { App } from '../App';
import { loadSettings, saveSettings } from '../utils/storage';

describe('Frontend Security & URL Redaction', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('PairingModal copies share URL with pairCode only and NEVER includes token', async () => {
    saveSettings({
      token: 'super-secret-token-do-not-share',
      pairCode: 'PAIR99',
    });

    let copiedText = '';
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockImplementation((text: string) => {
          copiedText = text;
          return Promise.resolve();
        }),
      },
    });

    render(
      <TerminalProvider>
        <PairingModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    const copyBtn = screen.getByRole('button', { name: /Copy Direct Connection Link/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(copiedText).toContain('pairCode=PAIR99');
    expect(copiedText).not.toContain('super-secret-token-do-not-share');
    expect(copiedText).not.toContain('token=');
  });

  it('App consumes token and pairCode from URL, stores them, and removes secret query params via replaceState', async () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    // Simulate arriving at /admin?token=secret-token-xyz&pairCode=CODE12
    const originalLocation = window.location;
    delete (window as unknown as { location: unknown }).location;
    window.location = new URL('http://localhost:5173/admin?token=secret-token-xyz&pairCode=CODE12') as unknown as Location;

    // Mock fetch for admin status
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          version: '0.1.0',
          uptimeSeconds: 50,
          clients: [],
          hosts: [],
          ptys: [],
          throughput: { bytesIn: 0, bytesOut: 0, bytesInPerSec: 0, bytesOutPerSec: 0, framesIn: 0, framesOut: 0, framesInPerSec: 0, framesOutPerSec: 0 },
          cpu: { load1m: 0, load5m: 0, load15m: 0, cpuPercent: 0, cores: 1 },
          memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
          eventLoopDelay: { p50Ms: 0, p99Ms: 0, maxMs: 0 },
          cleanup: { staleClientsPurged: 0, closedPtysCleaned: 0, deadConnectionsClosed: 0, idleHostsTerminated: 0 },
          protocolVersion: 1,
        }),
    });

    render(<App />);

    // Check settings were populated
    const saved = loadSettings();
    expect(saved.token).toBe('secret-token-xyz');
    expect(saved.pairCode).toBe('CODE12');

    // Check replaceState was called to sanitize URL
    expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/admin');

    // Restore location
    window.location = originalLocation;
    replaceStateSpy.mockRestore();
  });
});
