import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { TerminalProvider } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import { Gauge, LineGauge, Sparkline } from '../components/tui';

/**
 * The dashboard as a terminal status board.
 *
 * It is built from ratatui's widget vocabulary — a Gauge whose label sits
 * inside the bar, LineGauges for readings that only need comparing, Sparklines
 * for the history each poll records — and it says all of it in the interface's
 * own language, uptime units included.
 */

const STATUS_FIXTURE = {
  version: '0.2.1',
  uptimeSeconds: 3725,
  startTime: new Date().toISOString(),
  serverTime: new Date().toISOString(),
  activeControllerId: 'client-a',
  activeHostId: 'host-1',
  isRemoteRelay: false,
  clients: [
    { id: 'client-a', role: 'controller', connectedAt: new Date().toISOString() },
    { id: 'client-b', role: 'controller', connectedAt: new Date().toISOString() },
  ],
  hosts: [],
  ptys: [
    {
      id: 'session-1',
      pid: 1234,
      command: 'herdr',
      cols: 80,
      rows: 24,
      createdAt: new Date().toISOString(),
      activeClients: 2,
    },
  ],
  throughput: {
    bytesIn: 100,
    bytesOut: 200,
    bytesInPerSec: 10,
    bytesOutPerSec: 20,
    framesIn: 1,
    framesOut: 2,
    framesInPerSec: 1,
    framesOutPerSec: 3,
  },
  cpu: { load1m: 0.1, load5m: 0.2, load15m: 0.3, cpuPercent: 42, cores: 4 },
  memory: { rssBytes: 10485760, heapUsedBytes: 5242880, heapTotalBytes: 10485760 },
  eventLoopDelay: { p50Ms: 0.5, p99Ms: 1.2, maxMs: 2 },
  cleanup: {
    staleClientsPurged: 0,
    closedPtysCleaned: 0,
    deadConnectionsClosed: 0,
    idleHostsTerminated: 0,
  },
  protocolVersion: 1,
};

const INFO_FIXTURE = {
  ok: true,
  version: '0.2.1',
  protocol: 1,
  relayMode: 'local',
  adminConfigured: true,
  adminPath: '/admin',
  adminStatusPath: '/api/status',
};

function mockRelay() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/info') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(INFO_FIXTURE) });
    }
    if (url === '/api/status') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STATUS_FIXTURE) });
    }
    return Promise.reject(new Error(`Unexpected url: ${url}`));
  }) as unknown as typeof fetch;
}

describe('ratatui widgets', () => {
  it('renders a Gauge with its label inside the bar and a reported percentage', () => {
    render(<Gauge ratio={0.42} label="cpu 42%" aria-label="cpu" />);
    const bar = screen.getByRole('progressbar', { name: 'cpu' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar.textContent).toContain('cpu 42%');
  });

  it('clamps a Gauge rather than overflowing its track', () => {
    render(<Gauge ratio={4} aria-label="over" />);
    expect(screen.getByRole('progressbar', { name: 'over' })).toHaveAttribute('aria-valuenow', '100');
  });

  it('draws a LineGauge as a label, a rule and a figure', () => {
    render(<LineGauge label="load" ratio={0.5} value="0.50" />);
    expect(screen.getByText('load')).toBeInTheDocument();
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('draws a Sparkline from block characters, scaled to a ceiling when given one', () => {
    render(<Sparkline values={[0, 50, 100]} max={100} width={3} aria-label="cpu history" />);
    const spark = screen.getByRole('img', { name: 'cpu history' });
    // Half of eight steps rounds to the fifth bar, not the fourth.
    expect(spark.textContent).toBe('▁▅█');
  });

  it('pads a short history from the left instead of collapsing', () => {
    render(<Sparkline values={[100]} max={100} width={4} aria-label="short" />);
    expect(screen.getByRole('img', { name: 'short' }).textContent).toBe('▁▁▁█');
  });
});

describe('Admin status board', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    mockRelay();
  });

  it('reports the shared session, its gauges and its history in Chinese', async () => {
    saveSettings({ wsUrl: '/ws/client', token: 'device-token', language: 'zh' });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => expect(screen.getByText('session-1')).toBeInTheDocument());

    // One terminal, shared by every attached window.
    expect(screen.getByText(/个窗口共享该终端/)).toBeInTheDocument();

    // The CPU gauge states its own reading, inside the bar.
    const cpu = screen.getByRole('progressbar', { name: /CPU 使用率/ });
    expect(cpu).toHaveAttribute('aria-valuenow', '42');
    expect(cpu.textContent).toContain('42.0%');

    // Uptime in the interface's units, not `1h 2m 5s`.
    expect(screen.getByText(/1 小时 2 分 5 秒/)).toBeInTheDocument();

    // And the history the poll just recorded is drawn, not merely collected.
    expect(screen.getAllByRole('img', { name: /CPU 使用率/ }).length).toBeGreaterThan(0);
  });

  it('keeps English units on an English interface', async () => {
    saveSettings({ wsUrl: '/ws/client', token: 'device-token', language: 'en' });

    render(
      <TerminalProvider>
        <AdminDashboard />
      </TerminalProvider>
    );

    await waitFor(() => expect(screen.getByText('session-1')).toBeInTheDocument());
    expect(screen.getByText(/1h 2m 5s/)).toBeInTheDocument();
    expect(screen.getByText(/windows sharing this terminal/i)).toBeInTheDocument();
  });
});
