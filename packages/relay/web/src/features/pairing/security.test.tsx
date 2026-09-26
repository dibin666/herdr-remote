import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { TerminalProvider } from '@/context/TerminalContext';
import { PairingModal } from './PairingModal';
import { App } from '@/app/App';
import { loadSettings, saveSettings } from '@/features/settings/storage';
import type { MockWebSocket } from '@/test/setup';
import { createConnectionProfile } from './connectionProfiles';

const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

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
      </TerminalProvider>,
    );

    const copyBtn = screen.getByRole('button', { name: /Copy direct pairing link/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    expect(copiedText).toContain('pairCode=PAIR99');
    expect(copiedText).not.toContain('super-secret-token-do-not-share');
    expect(copiedText).not.toContain('token=');
  });

  it('never lets a link point the saved device token at another relay', () => {
    saveSettings({ wsUrl: '/ws/client', token: 'device-token-of-this-browser' });
    const originalLocation = window.location;
    delete (window as unknown as { location: unknown }).location;
    window.location = new URL(
      'http://localhost:5173/?ws=wss://evil.example/ws/client&wsUrl=wss://evil.example/ws/client',
    ) as unknown as Location;

    render(<App />);

    const saved = loadSettings();
    expect(saved.wsUrl).toBe('/ws/client');
    expect(saved.token).toBe('device-token-of-this-browser');
    expect(saved.profiles.map((profile) => profile.wsUrl)).toEqual(['/ws/client']);

    window.location = originalLocation;
  });

  it("keeps this browser's pairing when a link pairs it with another workstation", () => {
    const own = createConnectionProfile({
      id: 'profile-own',
      wsUrl: '/ws/client',
      token: 'own-device-token-123456',
      hostId: 'host-own',
    });
    saveSettings({ profiles: [own], activeProfileId: own.id, wsUrl: own.wsUrl, token: own.token });
    const originalLocation = window.location;
    delete (window as unknown as { location: unknown }).location;
    window.location = new URL('http://localhost:5173/?pairCode=OTHER1') as unknown as Location;
    webSocketInstances.length = 0;

    render(<App />);

    // The link's code is sent on its own, not alongside this device's token.
    const socket = webSocketInstances[webSocketInstances.length - 1];
    act(() => socket.simulateOpen());
    const hello = JSON.parse(socket.sent[0] as string);
    expect(hello.pairCode).toBe('OTHER1');
    expect(hello.token).toBeUndefined();

    act(() =>
      socket.simulateMessage(
        JSON.stringify({
          type: 'paired',
          token: 'other-device-token-123456',
          deviceId: 'device-other',
          hostId: 'host-other',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );

    const saved = loadSettings();
    expect(saved.profiles.find((item) => item.id === own.id)?.token).toBe(own.token);
    expect(saved.profiles.find((item) => item.hostId === 'host-other')?.token).toBe(
      'other-device-token-123456',
    );

    window.location = originalLocation;
  });

  it('re-pairing the same workstation from a link renews its profile instead of adding one', () => {
    const own = createConnectionProfile({
      id: 'profile-own',
      wsUrl: '/ws/client',
      token: 'own-device-token-123456',
      hostId: 'host-own',
    });
    saveSettings({ profiles: [own], activeProfileId: own.id, wsUrl: own.wsUrl, token: own.token });
    const originalLocation = window.location;
    delete (window as unknown as { location: unknown }).location;
    window.location = new URL('http://localhost:5173/?pairCode=AGAIN1') as unknown as Location;
    webSocketInstances.length = 0;

    render(<App />);

    const socket = webSocketInstances[webSocketInstances.length - 1];
    act(() => socket.simulateOpen());
    act(() =>
      socket.simulateMessage(
        JSON.stringify({
          type: 'paired',
          token: 'renewed-device-token-123456',
          deviceId: 'device-renewed',
          hostId: 'host-own',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );

    const saved = loadSettings();
    expect(saved.profiles).toHaveLength(1);
    expect(saved.profiles[0].id).toBe(own.id);
    expect(saved.token).toBe('renewed-device-token-123456');

    window.location = originalLocation;
  });

  it('App consumes pairCode from URL, ignores a token, and removes both via replaceState', async () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    // Simulate arriving at /admin?token=secret-token-xyz&pairCode=CODE12
    const originalLocation = window.location;
    delete (window as unknown as { location: unknown }).location;
    window.location = new URL(
      'http://localhost:5173/admin?token=secret-token-xyz&pairCode=CODE12',
    ) as unknown as Location;

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
          cpu: { load1m: 0, load5m: 0, load15m: 0, cpuPercent: 0, cores: 1 },
          memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0 },
          eventLoopDelay: { p50Ms: 0, p99Ms: 0, maxMs: 0 },
          cleanup: {
            staleClientsPurged: 0,
            closedPtysCleaned: 0,
            deadConnectionsClosed: 0,
            idleHostsTerminated: 0,
          },
          protocolVersion: 1,
        }),
    });

    render(<App />);

    // A token in a link is somebody else's device, not a way to pair this one.
    const saved = loadSettings();
    expect(saved.token).toBe('');
    expect(saved.pairCode).toBe('CODE12');

    // Check replaceState was called to sanitize URL
    expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/admin');

    // Restore location
    window.location = originalLocation;
    replaceStateSpy.mockRestore();
  });
});
