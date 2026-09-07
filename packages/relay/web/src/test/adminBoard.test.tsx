import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AdminDashboard } from '../components/admin/AdminDashboard';
import { HostsTable } from '../components/admin/HostsTable';
import { TerminalProvider } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import { Gauge, LineGauge, Sparkline } from '../components/tui';

/**
 * The dashboard as a public relay's status board.
 *
 * The question it exists to answer is "which workstations is this relay
 * carrying, and who is paired to each of them" — so the board is hosts, the
 * devices under them, and the traffic the relay is moving. The process
 * readings it used to lead with (CPU, heap, event-loop delay, GC tallies)
 * described the container's machine, not the service, and are gone.
 */

const NOW = new Date().toISOString();

const STATUS_FIXTURE = {
  version: '0.2.1',
  uptimeSeconds: 3725,
  startTime: NOW,
  serverTime: NOW,
  activeControllerId: null,
  activeHostId: 'host-alpha',
  isRemoteRelay: false,
  // Four windows, three devices: one person has the same laptop open twice.
  activeUserCount: 3,
  clients: [
    { id: 'client-a', role: 'controller', hostId: 'host-alpha', connectedAt: NOW },
    { id: 'client-b', role: 'controller', hostId: 'host-alpha', connectedAt: NOW },
    { id: 'client-c', role: 'controller', hostId: 'host-alpha', connectedAt: NOW },
    { id: 'client-d', role: 'controller', hostId: 'host-beta', connectedAt: NOW },
  ],
  hosts: [
    {
      id: 'host-alpha',
      hostname: 'workstation-alpha',
      platform: 'linux',
      status: 'busy' as const,
      connectedAt: NOW,
      activePtyCount: 1,
      connectedDeviceCount: 2,
      pairedDeviceCount: 2,
    },
    {
      id: 'host-beta',
      hostname: 'workstation-beta',
      platform: 'darwin',
      status: 'online' as const,
      connectedAt: NOW,
      activePtyCount: 0,
      connectedDeviceCount: 1,
      pairedDeviceCount: 1,
    },
  ],
  ptys: [
    {
      id: 'session-1',
      pid: 1234,
      command: 'herdr',
      cols: 80,
      rows: 24,
      createdAt: NOW,
      activeClients: 3,
    },
  ],
  devices: [
    {
      deviceId: 'device-alpha-1',
      hostId: 'host-alpha',
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: Date.now() + 86400000,
      expiresAtIso: NOW,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      lastIp: '10.0.0.5',
    },
    {
      deviceId: 'device-alpha-2',
      hostId: 'host-alpha',
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: Date.now() + 86400000,
      expiresAtIso: NOW,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      lastIp: '10.0.0.6',
    },
    {
      deviceId: 'device-beta-1',
      hostId: 'host-beta',
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: Date.now() + 86400000,
      expiresAtIso: NOW,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      lastIp: '10.0.0.7',
    },
    // Paired to a workstation that is not connected right now. The relay's
    // `hosts` list has no row for it at all.
    {
      deviceId: 'device-gamma-1',
      hostId: 'host-gamma',
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: Date.now() + 86400000,
      expiresAtIso: NOW,
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
      lastIp: '10.0.0.8',
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

function mockRelay(status: Record<string, unknown> = STATUS_FIXTURE) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/info') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(INFO_FIXTURE) });
    }
    if (url === '/api/status') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) });
    }
    return Promise.reject(new Error(`Unexpected url: ${url}`));
  }) as unknown as typeof fetch;
}

function renderDashboard(language: 'en' | 'zh') {
  saveSettings({ wsUrl: '/ws/client', token: 'device-token', language });
  return render(
    <TerminalProvider>
      <AdminDashboard />
    </TerminalProvider>
  );
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

describe('HostsTable', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSettings({ language: 'en' });
  });

  it('lists every paired device under the host it belongs to', () => {
    render(
      <TerminalProvider>
        <HostsTable
          hosts={STATUS_FIXTURE.hosts}
          devices={STATUS_FIXTURE.devices}
        />
      </TerminalProvider>
    );

    // Three hosts: two connected, plus the one only the roster remembers.
    expect(screen.getByText('Hosts (3)')).toBeInTheDocument();
    expect(screen.getByText('workstation-alpha')).toBeInTheDocument();
    expect(screen.getByText('workstation-beta')).toBeInTheDocument();

    // Devices are named the way an operator recognises them, with the id kept.
    expect(screen.getByText('iPhone · Safari')).toBeInTheDocument();
    expect(screen.getByText('macOS · Chrome')).toBeInTheDocument();
    expect(screen.getByText('device-alpha-1')).toBeInTheDocument();
    expect(screen.getByText('device-beta-1')).toBeInTheDocument();
  });

  it('shows a host nobody is connected to as offline rather than dropping it', () => {
    render(
      <TerminalProvider>
        <HostsTable hosts={STATUS_FIXTURE.hosts} devices={STATUS_FIXTURE.devices} />
      </TerminalProvider>
    );

    // `host-gamma` appears in no `hosts` row; only its paired device knows it.
    expect(screen.getByText('host-gamma')).toBeInTheDocument();
    expect(screen.getByText('Android · Chrome')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getAllByText('1 paired').length).toBeGreaterThan(0);
    // Offline means nothing is attached, whatever is paired to it.
    expect(screen.getAllByText('0 connected').length).toBeGreaterThan(0);
  });

  it('reports both counts per host', () => {
    render(
      <TerminalProvider>
        <HostsTable hosts={STATUS_FIXTURE.hosts} devices={STATUS_FIXTURE.devices} />
      </TerminalProvider>
    );

    expect(screen.getByText('2 connected')).toBeInTheDocument();
    expect(screen.getByText('2 paired')).toBeInTheDocument();
    expect(screen.getByText('In use')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('keeps the counts but says why the roster is missing without an operator token', () => {
    render(
      <TerminalProvider>
        <HostsTable hosts={STATUS_FIXTURE.hosts} />
      </TerminalProvider>
    );

    expect(screen.getByText('Hosts (2)')).toBeInTheDocument();
    expect(screen.getByText('2 paired')).toBeInTheDocument();
    expect(screen.queryByText('device-alpha-1')).not.toBeInTheDocument();
    expect(
      screen.getAllByText('Device list is visible to the relay operator only.').length
    ).toBe(2);
  });

  it('says so plainly when the relay carries nothing at all', () => {
    render(
      <TerminalProvider>
        <HostsTable hosts={[]} devices={[]} />
      </TerminalProvider>
    );

    expect(screen.getByText('No hosts connected or paired')).toBeInTheDocument();
  });
});

describe('Admin status board', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    mockRelay();
  });

  it('leads with hosts, their devices and the user count, in Chinese', async () => {
    renderDashboard('zh');

    await waitFor(() => expect(screen.getByText('workstation-alpha')).toBeInTheDocument());

    // Access overview: hosts, distinct users, and the windows behind them.
    expect(screen.getByText('接入概览')).toBeInTheDocument();
    expect(screen.getByText('接入主机')).toBeInTheDocument();
    expect(screen.getByText('活跃用户')).toBeInTheDocument();
    // Three people, four windows — the count is devices, not sockets.
    expect(screen.getByText('共 4 个窗口')).toBeInTheDocument();

    // Every host, with its two counts and its roster.
    expect(screen.getByText('主机 (3)')).toBeInTheDocument();
    expect(screen.getByText('2 台在线')).toBeInTheDocument();
    expect(screen.getByText('iPhone · Safari')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();

    // Uptime in the interface's units, not `1h 2m 5s`.
    expect(screen.getByText(/1 小时 2 分 5 秒/)).toBeInTheDocument();
  });

  it('keeps English units and labels on an English interface', async () => {
    renderDashboard('en');

    await waitFor(() => expect(screen.getByText('workstation-alpha')).toBeInTheDocument());

    expect(screen.getByText(/1h 2m 5s/)).toBeInTheDocument();
    expect(screen.getByText('Connected Hosts')).toBeInTheDocument();
    expect(screen.getByText('Active Users')).toBeInTheDocument();
    expect(screen.getByText('across 4 windows')).toBeInTheDocument();
    expect(screen.getByText('Hosts (3)')).toBeInTheDocument();
  });

  it('shows the active user count the relay reported, not the connection count', async () => {
    renderDashboard('en');

    await waitFor(() => expect(screen.getByText('Active Users')).toBeInTheDocument());

    const usersRow = screen.getByText('Active Users').parentElement as HTMLElement;
    // Three devices behind four connections.
    expect(within(usersRow).getByText('3')).toBeInTheDocument();
    expect(within(usersRow).getByText('across 4 windows')).toBeInTheDocument();
  });

  it('falls back to the connection count against a relay too old to report users', async () => {
    const { activeUserCount: _omitted, ...legacy } = STATUS_FIXTURE;
    mockRelay(legacy);
    renderDashboard('en');

    await waitFor(() => expect(screen.getByText('Active Users')).toBeInTheDocument());

    const usersRow = screen.getByText('Active Users').parentElement as HTMLElement;
    expect(within(usersRow).getByText('4')).toBeInTheDocument();
  });

  it('keeps one traffic panel and drops the process readings entirely', async () => {
    renderDashboard('en');

    await waitFor(() => expect(screen.getByText('workstation-alpha')).toBeInTheDocument());

    // Traffic survives: it is the one relay-wide reading an operator acts on.
    expect(screen.getByText('Throughput')).toBeInTheDocument();
    expect(screen.getByText('Total Inbound:')).toBeInTheDocument();
    expect(screen.getByText('Total Outbound:')).toBeInTheDocument();

    // The machine readings do not.
    for (const gone of [
      'CPU & Load',
      'CPU Utilization',
      'Memory',
      'Heap Utilization',
      'Event Loop Delay',
      'GC Cleanup Count',
      'Process RSS',
      '1m Load',
      'p50 latency',
      'Stale Clients Purged',
    ]) {
      expect(screen.queryByText(gone), `"${gone}" should be gone from the board`).toBeNull();
    }
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('drops the Chinese performance labels too', async () => {
    renderDashboard('zh');

    await waitFor(() => expect(screen.getByText('workstation-alpha')).toBeInTheDocument());

    for (const gone of [
      'CPU 与系统负载',
      'CPU 使用率',
      '内存资源',
      '堆内存使用率',
      '事件循环延迟',
      'GC 清理计数',
      '进程常驻内存',
      '已清理过期客户端',
    ]) {
      expect(screen.queryByText(gone), `"${gone}" should be gone from the board`).toBeNull();
    }

    // And the overview tab no longer promises performance it does not show.
    expect(screen.getByLabelText('系统概览')).toBeInTheDocument();
    expect(screen.queryByLabelText('系统概览与性能')).toBeNull();
  });
});
