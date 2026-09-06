import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { TerminalProvider } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';

describe('Local vs Remote Relay Admin Dashboard & /api/info Contract', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders full local admin metrics when /api/info reports relayMode local', async () => {
    saveSettings({ wsUrl: '/ws/client', token: 'mock-device-token' });

    const infoFixture = {
      ok: true,
      version: '0.1.0',
      protocol: 1,
      relayMode: 'local',
      adminConfigured: true,
      adminPath: '/admin',
      adminStatusPath: '/api/status',
    };

    const localStatusFixture = {
      version: '0.1.0',
      uptimeSeconds: 3600,
      startTime: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      activeControllerId: 'client-local-1',
      activeHostId: 'host-local-1',
      isRemoteRelay: false,
      clients: [
        { id: 'client-local-1', role: 'controller', connectedAt: new Date().toISOString() },
      ],
      hosts: [],
      ptys: [
        { id: 'pty-1', pid: 1234, command: 'bash', cols: 80, rows: 24, createdAt: new Date().toISOString(), activeClients: 1 },
      ],
      throughput: { bytesIn: 100, bytesOut: 200, bytesInPerSec: 10, bytesOutPerSec: 20, framesIn: 1, framesOut: 2, framesInPerSec: 1, framesOutPerSec: 1 },
      cpu: { load1m: 0.1, load5m: 0.2, load15m: 0.3, cpuPercent: 5.0, cores: 4 },
      memory: { rssBytes: 10485760, heapUsedBytes: 5242880, heapTotalBytes: 10485760 },
      eventLoopDelay: { p50Ms: 0.5, p99Ms: 1.2, maxMs: 2.0 },
      cleanup: { staleClientsPurged: 0, closedPtysCleaned: 0, deadConnectionsClosed: 0, idleHostsTerminated: 0 },
      protocolVersion: 1,
    };

    let statusCalled = false;
    let authHeader = '';

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/info') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(infoFixture),
        });
      }
      if (url === '/api/status') {
        statusCalled = true;
        authHeader = (init?.headers as Record<string, string>)?.[`Authorization`] || '';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(localStatusFixture),
        });
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    }) as unknown as typeof fetch;

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('pty-1')).toBeInTheDocument();
    });

    // Verify /api/status was called with Bearer device token
    expect(statusCalled).toBe(true);
    expect(authHeader).toBe('Bearer mock-device-token');

    // Check stats are rendered
    expect(screen.getAllByText('client-local-1').length).toBeGreaterThan(0);
    expect(screen.getByText('pty-1')).toBeInTheDocument();
    expect(screen.queryByText(/Remote Relay Administration|远程 Relay 服务管理/i)).toBeNull();
  });

  it('NEVER calls /api/status and does NOT render CPU/client cards when remote relay has no admin token', async () => {
    saveSettings({ wsUrl: 'wss://relay.example.com/ws/client', token: 'regular-device-token' });

    const infoFixture = {
      ok: true,
      version: '0.1.0',
      protocol: 1,
      relayMode: 'remote',
      adminConfigured: true,
      adminPath: '/admin',
      adminStatusPath: '/api/admin/status',
      publicUrl: 'https://relay.example.com',
    };

    const requestedEndpoints: string[] = [];

    global.fetch = vi.fn().mockImplementation((url: string) => {
      requestedEndpoints.push(url);
      if (url === 'https://relay.example.com/api/info') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(infoFixture),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Should not be called',
      });
    }) as unknown as typeof fetch;

    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Remote Relay Administration|远程 Relay 服务管理/i)).toBeInTheDocument();
    });

    // 1. Assert: /api/status was NEVER requested!
    expect(requestedEndpoints).toEqual(['https://relay.example.com/api/info']);
    expect(requestedEndpoints).not.toContain('/api/status');
    expect(requestedEndpoints).not.toContain('/api/admin/status');

    // 2. Assert: Metric cards (CPU Utilization, Memory, Connected Clients) are NOT rendered
    expect(screen.queryByText(/CPU Utilization|CPU 使用率/i)).toBeNull();
    expect(screen.queryByText(/Active Clients|活跃客户端/i)).toBeNull();
    expect(screen.queryByText(/Active PTYs|活动 PTY/i)).toBeNull();

    // 3. Assert: Remote guidance view is rendered
    expect(screen.getByText('wss://relay.example.com/ws/client')).toBeInTheDocument();

    const openRemoteBtn = screen.getByRole('button', { name: /Open Remote Admin|前往远程管理后台/i });
    expect(openRemoteBtn).toBeInTheDocument();

    fireEvent.click(openRemoteBtn);
    expect(windowOpenSpy).toHaveBeenCalledWith('https://relay.example.com/admin', '_blank', 'noopener,noreferrer');
  });

  it('allows entering X-Relay-Admin-Token to access /api/admin/status on remote relay without Bearer token', async () => {
    saveSettings({ wsUrl: 'wss://relay.example.com/ws/client', token: 'device-token-not-admin' });

    const infoFixture = {
      ok: true,
      version: '0.1.0',
      protocol: 1,
      relayMode: 'remote',
      adminConfigured: true,
      adminPath: '/admin',
      adminStatusPath: '/api/admin/status',
    };

    let requestedUrl = '';
    let requestedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === 'https://relay.example.com/api/info') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(infoFixture),
        });
      }
      requestedUrl = url;
      requestedHeaders = (init?.headers as Record<string, string>) || {};

      if (requestedHeaders['X-Relay-Admin-Token'] === 'secret-admin-pass') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              version: '0.1.0',
              uptimeSeconds: 500,
              startTime: new Date().toISOString(),
              serverTime: new Date().toISOString(),
              clients: [
                { id: 'client-remote-op', role: 'controller', connectedAt: new Date().toISOString() },
              ],
              hosts: [],
              ptys: [],
              throughput: { bytesIn: 0, bytesOut: 0, bytesInPerSec: 0, bytesOutPerSec: 0, framesIn: 0, framesOut: 0, framesInPerSec: 0, framesOutPerSec: 0 },
              cpu: { load1m: 0.5, load5m: 0.3, load15m: 0.2, cpuPercent: 12, cores: 8 },
              memory: { rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 1000 },
              eventLoopDelay: { p50Ms: 1, p99Ms: 2, maxMs: 3 },
              cleanup: { staleClientsPurged: 0, closedPtysCleaned: 0, deadConnectionsClosed: 0, idleHostsTerminated: 0 },
              protocolVersion: 1,
            }),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });
    }) as unknown as typeof fetch;

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Remote Relay Administration|远程 Relay 服务管理/i)).toBeInTheDocument();
    });

    // Click operator login button
    const loginBtn = screen.getByRole('button', { name: /Verify & View Metrics|验证并查看服务端指标/i });
    fireEvent.click(loginBtn);

    // Enter token
    const tokenInput = screen.getByPlaceholderText(/Enter RELAY_ADMIN_TOKEN|请输入 RELAY_ADMIN_TOKEN/i);
    fireEvent.change(tokenInput, { target: { value: 'secret-admin-pass' } });

    const submitBtn = screen.getAllByRole('button', { name: /Verify & View Metrics|验证并查看服务端指标/i })[0];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(requestedUrl).toBe('https://relay.example.com/api/admin/status');
      // Assert: only X-Relay-Admin-Token is sent, never Bearer device token
      expect(requestedHeaders['X-Relay-Admin-Token']).toBe('secret-admin-pass');
      expect(requestedHeaders['Authorization']).toBeUndefined();
      expect(screen.getByText('client-remote-op')).toBeInTheDocument();
    });
  });
});
