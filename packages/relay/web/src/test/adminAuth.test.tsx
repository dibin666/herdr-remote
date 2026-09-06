import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { saveSettings } from '../utils/storage';

describe('AdminDashboard Authentication & Status Fetch', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends Authorization Bearer header when token is set and renders data on 200 OK', async () => {
    saveSettings({ token: 'test-auth-token-123' });

    let capturedHeaders: Record<string, string> | undefined;

    const mockResponseData = {
      version: '0.1.0',
      uptimeSeconds: 3600,
      startTime: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      activeControllerId: 'client-alice',
      activeHostId: 'host-main',
      clients: [
        {
          id: 'client-alice',
          role: 'controller',
          ip: '10.0.0.1',
          connectedAt: new Date().toISOString(),
        },
      ],
      hosts: [],
      ptys: [
        {
          id: 'pty-1',
          pid: 1234,
          command: 'bash',
          cols: 80,
          rows: 24,
          createdAt: new Date().toISOString(),
          activeClients: 1,
        },
      ],
      throughput: {
        bytesIn: 100,
        bytesOut: 200,
        bytesInPerSec: 10,
        bytesOutPerSec: 20,
        framesIn: 5,
        framesOut: 10,
        framesInPerSec: 1,
        framesOutPerSec: 2,
      },
      cpu: { load1m: 0.1, load5m: 0.2, load15m: 0.3, cpuPercent: 5.0, cores: 4 },
      memory: { rssBytes: 1024 * 1024 * 10, heapUsedBytes: 1024 * 1024 * 5, heapTotalBytes: 1024 * 1024 * 8 },
      eventLoopDelay: { p50Ms: 1.0, p99Ms: 2.0, maxMs: 3.0 },
      cleanup: { staleClientsPurged: 0, closedPtysCleaned: 0, deadConnectionsClosed: 0, idleHostsTerminated: 0 },
      protocolVersion: 1,
    };

    global.fetch = vi.fn().mockImplementation((url, init) => {
      if (url === '/api/status') {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(mockResponseData),
        });
      }
      return Promise.reject(new Error('Not found'));
    });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByText('client-alice').length).toBeGreaterThan(0);
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.['Authorization']).toBe('Bearer test-auth-token-123');
    expect(screen.getByText('pty-1')).toBeInTheDocument();
  });

  it('displays authentication error and does NOT display fabricated metrics on 401', async () => {
    saveSettings({ token: 'invalid-token' });

    global.fetch = vi.fn().mockImplementation((url) => {
      if (url === '/api/status') {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        });
      }
      return Promise.reject(new Error('Not found'));
    });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Admin Status Unauthorized \(401\/403\)/i)
      ).toBeInTheDocument();
    });

    // Ensure NO fabricated demo metrics/clients are rendered
    expect(screen.queryByText('client-master')).not.toBeInTheDocument();
    expect(screen.queryByText('host-herdr-core-01')).not.toBeInTheDocument();
    expect(screen.queryByText('pty-session-1')).not.toBeInTheDocument();
  });

  it('displays authentication error on 403 Forbidden', async () => {
    saveSettings({ token: '' });

    global.fetch = vi.fn().mockImplementation((url) => {
      if (url === '/api/status') {
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        });
      }
      return Promise.reject(new Error('Not found'));
    });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Admin Status Unauthorized \(401\/403\)/i)
      ).toBeInTheDocument();
    });

    expect(screen.queryByText('client-master')).not.toBeInTheDocument();
  });
});
