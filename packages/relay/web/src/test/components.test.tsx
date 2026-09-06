import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { RoleControlBadge } from '../components/RoleControlBadge';
import { StatusBanner } from '../components/StatusBanner';
import { KeyToolbar } from '../components/KeyToolbar';
import { OnboardingView } from '../components/OnboardingView';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { saveSettings } from '../utils/storage';

describe('UI Components', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders RoleControlBadge with offline status when disconnected', () => {
    render(
      <TerminalProvider>
        <RoleControlBadge />
      </TerminalProvider>
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Offline/i)).toBeInTheDocument();
  });

  it('renders OnboardingView with pairing steps and command copy', () => {
    render(
      <TerminalProvider>
        <OnboardingView />
      </TerminalProvider>
    );

    expect(screen.getByText(/Pair with Herdr Remote/i)).toBeInTheDocument();
    expect(screen.getByText(/node bin\/service\.js pair/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect & Pair Device/i })).toBeInTheDocument();
  });

  it('renders StatusBanner when token is set and disconnected', () => {
    saveSettings({ token: 'existing-saved-token' });

    render(
      <TerminalProvider>
        <StatusBanner />
      </TerminalProvider>
    );

    expect(screen.getByText(/Terminal disconnected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('renders KeyToolbar with touch keys', () => {
    render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>
    );

    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(screen.getByTitle(/Escape/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Tab/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Toggle Ctrl modifier latch/i)).toBeInTheDocument();
  });

  it('renders AdminDashboard with stats and tabs', async () => {
    const mockData = {
      version: '0.1.0',
      uptimeSeconds: 100,
      startTime: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      activeControllerId: 'client-1',
      activeHostId: 'host-1',
      clients: [{ id: 'client-1', role: 'controller', connectedAt: new Date().toISOString() }],
      hosts: [],
      ptys: [{ id: 'pty-1', pid: 100, command: 'bash', cols: 80, rows: 24, createdAt: new Date().toISOString(), activeClients: 1 }],
      throughput: { bytesIn: 0, bytesOut: 0, bytesInPerSec: 0, bytesOutPerSec: 0, framesIn: 0, framesOut: 0, framesInPerSec: 0, framesOutPerSec: 0 },
      cpu: { load1m: 0.1, load5m: 0.1, load15m: 0.1, cpuPercent: 5, cores: 2 },
      memory: { rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 1000 },
      eventLoopDelay: { p50Ms: 1, p99Ms: 2, maxMs: 3 },
      cleanup: { staleClientsPurged: 0, closedPtysCleaned: 0, deadConnectionsClosed: 0, idleHostsTerminated: 0 },
      protocolVersion: 1,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockData),
    });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    expect(screen.getByText(/System Administration/i)).toBeInTheDocument();
  });
});
