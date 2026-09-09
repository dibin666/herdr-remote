import React, { useState, useEffect, useCallback } from 'react';
import { AdminStatusResponse, RelayInfoResponse } from '../../types/admin';
import { useTerminal } from '../../context/TerminalContext';
import { ClientsTable } from './ClientsTable';
import { HostsTable } from './HostsTable';
import { PtysTable } from './PtysTable';
import { DevicesTable } from './DevicesTable';
import { cn } from '../../utils/cn';
import { copyText } from '../../utils/clipboard';
import {
  AppFrame,
  Badge,
  Button,
  FieldLabel,
  GLYPH,
  Input,
  Notice,
  Panel,
  Row,
  Rule,
  Select,
  Spinner,
  StatusDot,
} from '../tui';

/** Resolve the active profile's relay origin without performing discovery. */
function relayHttpBase(wsUrl: string): string {
  if (typeof window === 'undefined' || !wsUrl || wsUrl.startsWith('/')) return '';
  try {
    const url = new URL(wsUrl.replace(/^ws/, 'http'));
    const pathname = url.pathname.replace(/\/ws\/client\/?$/, '').replace(/\/+$/, '');
    // Keep the existing same-origin relative fetch contract. Absolute URLs are
    // needed only when a profile points at another relay origin.
    if (url.origin === window.location.origin && !pathname) return '';
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

function relayEndpoint(wsUrl: string, endpoint: string): string {
  const base = relayHttpBase(wsUrl);
  if (!base) return endpoint;
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

interface AdminDashboardProps {
  onBackToTerminal?: () => void;
  onOpenPairing?: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  onBackToTerminal,
  onOpenPairing,
}) => {
  const { settings, updateSettings, addToast, t } = useTerminal();
  const activeRelayOrigin = relayHttpBase(settings.wsUrl)
    || (typeof window !== 'undefined' ? window.location.origin : 'local');
  const savedAdminToken = settings.adminTokens?.[activeRelayOrigin]
    || (activeRelayOrigin === (typeof window !== 'undefined' ? window.location.origin : 'local') ? settings.adminToken : '')
    || '';
  const [data, setData] = useState<AdminStatusResponse | null>(null);
  const [relayInfo, setRelayInfo] = useState<RelayInfoResponse | null>(null);
  const [infoLoaded, setInfoLoaded] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);
  const [refreshInterval, setRefreshInterval] = useState<number>(3000); // 3 seconds
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'clients' | 'ptys' | 'devices'>('overview');
  const [copiedPairCmd, setCopiedPairCmd] = useState(false);

  // Relay Operator Token for GET /api/admin/status
  const [adminTokenInput, setAdminTokenInput] = useState(savedAdminToken);
  const [isOperatorView, setIsOperatorView] = useState(Boolean(savedAdminToken));

  const PAIR_COMMAND = 'node bin/service.js pair';

  useEffect(() => {
    setAdminTokenInput(savedAdminToken);
    setIsOperatorView(Boolean(savedAdminToken));
    setData(null);
    setRelayInfo(null);
    setInfoLoaded(false);
  }, [activeRelayOrigin]);

  const handleCopyPairCmd = () => {
    copyText(PAIR_COMMAND).then((res) => {
      if (res === 'failed') {
        addToast('error', t('clipboard.copyFailed'));
        return;
      }
      setCopiedPairCmd(true);
      addToast('success', t('toasts.commandCopied'));
      setTimeout(() => setCopiedPairCmd(false), 2000);
    });
  };

  // 1. Fetch Relay Info metadata from unauthenticated GET /api/info FIRST
  useEffect(() => {
    let isMounted = true;
    setLoading(true);

    async function checkRelayInfo() {
      try {
        const res = await fetch(relayEndpoint(settings.wsUrl, '/api/info'), {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const info = (await res.json()) as RelayInfoResponse;
          if (isMounted) {
            setRelayInfo(info);
            setInfoLoaded(true);
          }
          return;
        }
      } catch {
        // Fallback for legacy local servers without /api/info
      }

      if (isMounted) {
        const isRemoteUrl = Boolean(
          settings.wsUrl &&
            !settings.wsUrl.startsWith('/') &&
            !settings.wsUrl.includes('localhost') &&
            !settings.wsUrl.includes('127.0.0.1') &&
            (typeof window !== 'undefined' &&
              !settings.wsUrl.startsWith(window.location.origin.replace('http', 'ws')))
        );

        setRelayInfo({
          ok: true,
          version: '0.1.0',
          protocol: 1,
          relayMode: isRemoteUrl ? 'remote' : 'local',
          adminConfigured: false,
          adminPath: '/admin',
          adminStatusPath: '/api/admin/status',
        });
        setInfoLoaded(true);
      }
    }

    checkRelayInfo();
    return () => {
      isMounted = false;
    };
  }, [settings.wsUrl, activeRelayOrigin]);

  const isRemoteRelay = relayInfo?.relayMode === 'remote';

  // Derives remote admin URL
  const getRemoteAdminUrl = (): string => {
    if (relayInfo?.adminPath) {
      if (relayInfo.publicUrl) {
        return `${relayInfo.publicUrl.replace(/\/$/, '')}${relayInfo.adminPath}`;
      }
      return relayEndpoint(settings.wsUrl, relayInfo.adminPath);
    }
    if (data?.remoteAdminUrl) return data.remoteAdminUrl;
    if (settings.wsUrl) {
      try {
        return relayEndpoint(settings.wsUrl, '/admin');
      } catch {
        // ignore
      }
    }
    return '/admin';
  };

  // 2. Fetch status strictly respecting local vs remote boundary
  const fetchStatus = useCallback(async () => {
    if (!infoLoaded) return;

    // Case A: REMOTE relay
    if (isRemoteRelay) {
      // If client has not entered/saved admin token and is not operating the relay:
      // NEVER request /api/status! Do not pretend to be local workstation.
      if (!isOperatorView && !adminTokenInput) {
        setData(null);
        setLoading(false);
        setError(null);
        setIsAuthError(false);
        return;
      }

      // Remote operator mode: strictly request GET /api/admin/status with X-Relay-Admin-Token
      try {
        setLoading(true);
        const targetEndpoint = relayEndpoint(settings.wsUrl, relayInfo?.adminStatusPath || '/api/admin/status');
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'X-Relay-Admin-Token': adminTokenInput,
        };

        const res = await fetch(targetEndpoint, { headers });

        if (res.status === 401 || res.status === 403) {
          setIsAuthError(true);
          setError(t('admin.relayAdminAuthError'));
          setData(null);
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const json = (await res.json()) as AdminStatusResponse;
        setData(json);
        setError(null);
        setIsAuthError(false);
        setLastUpdated(new Date());
      } catch (err) {
        console.warn('GET /api/admin/status request failed:', err);
        setIsAuthError(false);
        setError(err instanceof Error ? err.message : 'Failed to fetch remote admin status');
        setData(null);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Case B: LOCAL relay (run by herdr-remote on local machine)
    try {
      setLoading(true);
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };

      if (settings.token) {
        headers['Authorization'] = `Bearer ${settings.token}`;
      }

      const res = await fetch('/api/status', {
        headers,
      });

      if (res.status === 401 || res.status === 403) {
        setIsAuthError(true);
        setError(
          `Authentication failed (HTTP ${res.status}): Access denied. Please configure an authorized token or pair with the host.`
        );
        setData(null);
        return;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = (await res.json()) as AdminStatusResponse;
      setData(json);
      setError(null);
      setIsAuthError(false);
      setLastUpdated(new Date());
    } catch (err) {
      console.warn('GET /api/status request failed:', err);
      setIsAuthError(false);
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [infoLoaded, isRemoteRelay, isOperatorView, adminTokenInput, relayInfo, settings.token, settings.wsUrl, activeRelayOrigin, t]);

  /**
   * Revoke a paired device. The relay drops the stored token hash and closes
   * whatever sockets it still holds, so this refreshes straight afterwards to
   * show the client disappearing rather than waiting for the poll interval.
   */
  const revokeDevice = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(relayEndpoint(settings.wsUrl, `/api/admin/devices/${encodeURIComponent(deviceId)}`), {
        method: 'DELETE',
        headers: { Accept: 'application/json', 'X-Relay-Admin-Token': adminTokenInput },
      });
      if (!res.ok) {
        setError(t('admin.revokeFailed'));
        return;
      }
      await fetchStatus();
    } catch {
      setError(t('admin.revokeFailed'));
    }
  }, [adminTokenInput, fetchStatus, settings.wsUrl, t]);

  useEffect(() => {
    if (!infoLoaded) return;
    fetchStatus();

    let timer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (refreshInterval > 0 && !timer) {
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') {
            fetchStatus();
          }
        }, refreshInterval);
      }
    };

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus();
        startPolling();
      } else {
        stopPolling();
      }
    };

    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [infoLoaded, fetchStatus, refreshInterval]);

  const handleSaveAdminToken = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanToken = adminTokenInput.trim();
    updateSettings({
      adminToken: cleanToken,
      adminTokens: {
        ...(settings.adminTokens || {}),
        [activeRelayOrigin]: cleanToken,
      },
    });
    setIsOperatorView(Boolean(cleanToken));
  };

  /**
   * An uptime in the interface's own units.
   *
   * `1h 24m 1s` is English abbreviation, and it stayed English on a Chinese
   * screen — which is exactly the kind of leftover that makes a translated UI
   * read as half-translated.
   */
  const formatUptime = (seconds: number): string => {
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const unit = (value: number, key: string) => `${value}${t(`admin.unit${key}`)}`;
    if (days > 0) return [unit(days, 'Day'), unit(hours, 'Hour'), unit(mins, 'Minute')].join(' ');
    if (hours > 0) return [unit(hours, 'Hour'), unit(mins, 'Minute'), unit(secs, 'Second')].join(' ');
    return [unit(mins, 'Minute'), unit(secs, 'Second')].join(' ');
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const handleOpenRemoteAdmin = () => {
    const remoteUrl = getRemoteAdminUrl();
    window.open(remoteUrl, '_blank', 'noopener,noreferrer');
  };

  /**
   * How many people are attached, not how many sockets are open.
   *
   * Several windows of one browser are one paired device and therefore one
   * user. A relay too old to report the figure only knows about connections,
   * which is the closest honest fallback.
   */
  const activeUserCount = data ? data.activeUserCount ?? data.clients?.length ?? 0 : 0;

  const tabs = data
    ? [
        { id: 'overview', label: t('admin.tabOverview'), index: 1 },
        { id: 'clients', label: t('admin.tabClients', { count: data.clients?.length || 0 }), index: 2 },
        { id: 'ptys', label: t('admin.tabPtys', { count: data.ptys?.length || 0 }), index: 3 },
        // The roster only exists in the operator response, so the tab only
        // exists once this dashboard is authenticated as the operator.
        ...(data.devices
          ? [{ id: 'devices', label: t('admin.tabDevices', { count: data.devices.length }), index: 4 }]
          : []),
      ]
    : [];

  // Admin is a real TUI screen, not just a clickable dashboard. Number keys
  // select its tabs, `r` refreshes the status line, and Escape returns to the
  // terminal. Ignore those keys while an input/select or a modal owns focus.
  const tabIds = tabs.map((tab) => tab.id);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }

      if (event.key === 'Escape' && onBackToTerminal) {
        event.preventDefault();
        onBackToTerminal();
        return;
      }

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        fetchStatus();
        return;
      }

      const index = Number.parseInt(event.key, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < tabIds.length) {
        event.preventDefault();
        setActiveTab(tabIds[index] as typeof activeTab);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fetchStatus, tabIds.join('|')]);

  const frameAside = (
    <div className="flex shrink-0 items-center gap-2">
      {onBackToTerminal && (
        <Button
          variant="ghost"
          onClick={onBackToTerminal}
          title={t('admin.returnToTerminal')}
          aria-label={t('admin.returnToTerminal')}
          glyph={GLYPH.arrowLeft}
          brackets={false}
          className="shrink-0"
        >
          <span className="sr-only">{t('admin.returnToTerminal')}</span>
        </Button>
      )}
      <span className="hidden text-tui-sm text-tui-accent sm:inline">
        v{relayInfo?.version || data?.version || '0.1.0'}
      </span>
      <Badge tone={isRemoteRelay ? 'alt' : 'ok'}>
        {isRemoteRelay ? t('admin.modeRemote') : t('admin.localWorkstationBadge')}
      </Badge>
      <label className="hidden items-center gap-1.5 text-tui-sm text-tui-muted md:flex">
        <span>{t('admin.autoRefresh')}</span>
        <Select
          value={refreshInterval}
          onChange={(e) => setRefreshInterval(Number(e.target.value))}
          aria-label={t('admin.autoRefresh')}
          className="w-auto"
        >
          <option value={0}>{t('admin.paused')}</option>
          <option value={1000}>1s</option>
          <option value={3000}>3s</option>
          <option value={5000}>5s</option>
          <option value={10000}>10s</option>
        </Select>
      </label>
      <Button
        variant="primary"
        onClick={fetchStatus}
        disabled={loading}
        title={t('admin.refreshNow')}
      >
        {loading ? <Spinner /> : t('admin.refreshNow')}
      </Button>
    </div>
  );

  return (
    <AppFrame
      name={t('admin.title')}
      tagline={t('admin.subtitle')}
      aside={frameAside}
      tabs={tabs}
      activeTabId={activeTab}
      onSelectTab={(id) => setActiveTab(id as typeof activeTab)}
      tabsAriaLabel={t('header.mainNavigationAria')}
      hints={[
        { keys: '1–4', action: t('admin.hintTabs') },
        { keys: 'r', action: t('admin.hintRefresh') },
        ...(onBackToTerminal ? [{ keys: 'esc', action: t('admin.hintBack') }] : []),
      ]}
      footerAside={
        lastUpdated ? (
          <span className="text-tui-faint">
            {t('admin.updatedAt', { time: lastUpdated.toLocaleTimeString() })}
          </span>
        ) : null
      }
      bodyClassName="space-y-3 pb-2"
    >
      {/* Loading state before info is determined */}
      {!infoLoaded && (
        <div className="flex items-center justify-center gap-2 border border-tui-border bg-tui-base px-3 py-8 text-tui text-tui-muted">
          <Spinner label={t('admin.loadingStatus')} />
        </div>
      )}

      {/* Remote relay, seen from a client: this is not your dashboard. */}
      {infoLoaded && isRemoteRelay && !isOperatorView && (
        <Panel
          title={t('admin.remoteRelayTitle')}
          aside={t('admin.remoteRelayBadge')}
          bodyClassName="space-y-2"
        >
          <p className="text-tui leading-snug text-tui-muted">{t('admin.remoteRelayNotice')}</p>

          <div className="space-y-0.5 border border-tui-border-dim bg-tui-mantle px-2 py-1.5">
            <Row label={t('admin.remoteRelayEndpoint')} labelWidth={18}>
              <code className="break-all text-tui-accent">{settings.wsUrl}</code>
            </Row>
            <Row label={t('admin.remoteRelayAdminUrl')} labelWidth={18}>
              <code className="break-all text-tui-ok">{getRemoteAdminUrl()}</code>
            </Row>
          </div>

          <Rule />

          <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
            <p className="text-tui-sm leading-snug text-tui-faint">{t('admin.remoteRelayHelp')}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button onClick={() => setIsOperatorView(true)}>
                {t('admin.relayAdminLoginBtn')}
              </Button>
              <Button variant="primary" onClick={handleOpenRemoteAdmin} glyph={GLYPH.arrowRight}>
                {t('admin.openRemoteAdminBtn')}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {/* Operator sign-in for the relay-wide dashboard. */}
      {infoLoaded && isRemoteRelay && isOperatorView && !data && (
        <Panel title={t('admin.relayAdminTitle')} bodyClassName="space-y-2">
          <Notice tone={relayInfo?.adminConfigured === false ? 'warn' : 'bad'}>
            {relayInfo?.adminConfigured === false
              ? t('admin.relayAdminNotConfigured')
              : t('admin.relayAdminAuthError')}
          </Notice>

          <form onSubmit={handleSaveAdminToken} className="space-y-2">
            <div className="space-y-1">
              <FieldLabel htmlFor="relay-admin-token">
                {t('admin.relayAdminTokenLabel')}
              </FieldLabel>
              <Input
                id="relay-admin-token"
                type="password"
                value={adminTokenInput}
                onChange={(e) => setAdminTokenInput(e.target.value)}
                placeholder={t('admin.relayAdminTokenPlaceholder')}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="primary" type="submit">
                {t('admin.relayAdminLoginBtn')}
              </Button>
              <Button variant="ghost" onClick={() => setIsOperatorView(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {/* Local relay refusing this device's token. */}
      {infoLoaded && !isRemoteRelay && isAuthError && (
        <Panel title={t('admin.unauthorizedTitle')} tone="bad" bodyClassName="space-y-2">
          <Notice tone="bad">{t('admin.unauthorizedDesc')}</Notice>

          <div className="space-y-1.5 border border-tui-border-dim bg-tui-mantle px-2 py-1.5">
            <span className="block text-tui-sm uppercase text-tui-muted">
              {t('admin.pairingStepsTitle')}
            </span>
            <div className="flex items-center gap-2 border border-tui-border bg-tui-crust px-2 py-1">
              <span aria-hidden="true" className="shrink-0 select-none text-tui-ok">
                $
              </span>
              <code className="min-w-0 flex-1 truncate text-tui-text">{PAIR_COMMAND}</code>
              <Button
                onClick={handleCopyPairCmd}
                glyph={copiedPairCmd ? GLYPH.check : '⧉'}
                className={cn('shrink-0', copiedPairCmd && 'border-tui-ok text-tui-ok')}
              >
                {copiedPairCmd ? t('admin.copiedJson') : t('common.copy')}
              </Button>
            </div>
            <p className="text-tui-sm text-tui-faint">{t('admin.pairingStepsHelp')}</p>
          </div>

          <div className="flex items-center gap-2">
            {onOpenPairing && (
              <Button variant="primary" onClick={onOpenPairing}>
                {t('admin.enterPairCodeBtn')}
              </Button>
            )}
            <Button onClick={fetchStatus}>{t('admin.retryFetchBtn')}</Button>
          </div>
        </Panel>
      )}

      {/* Anything else that went wrong on the wire. */}
      {infoLoaded && error && !isAuthError && !(!isRemoteRelay && isAuthError) && (
        <Notice
          tone="warn"
          action={
            <Button variant="warn" onClick={fetchStatus}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('admin.errorConnecting', { error })}
        </Notice>
      )}

      {/* Display Live Dashboard Data when Available */}
      {data && (
        <>
          {/* Tab: Overview */}
          {activeTab === 'overview' && (
            <div className="space-y-2">
              {/*
               * A public relay's operator has two questions, and the board
               * answers them in that order: who is attached to which
               * workstation, and how much traffic the relay is carrying for
               * them. The process readings that used to fill the rest of this
               * grid — CPU, heap, event-loop delay, the cleanup tallies —
               * describe whatever host runs the container, not the service
               * being operated, and they crowded out the one thing only this
               * relay can report: its hosts and their paired devices.
               */}
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Panel
                  title={t('admin.accessPanel')}
                  aside={formatUptime(data.uptimeSeconds || 0)}
                  bodyClassName="space-y-0.5"
                >
                  <Row label={t('admin.connectedHosts')} labelWidth={14}>
                    <span className="flex items-center gap-1.5">
                      <StatusDot level={data.hosts?.length ? 'ok' : 'idle'} />
                      <span className="font-bold">{data.hosts?.length || 0}</span>
                    </span>
                  </Row>
                  <Row label={t('admin.activeUsers')} labelWidth={14}>
                    <span className="flex items-center gap-1.5">
                      <StatusDot level={activeUserCount ? 'ok' : 'idle'} />
                      <span className="font-bold">{activeUserCount}</span>
                      <span className="text-tui-faint">
                        {t('admin.acrossWindows', { count: data.clients?.length || 0 })}
                      </span>
                    </span>
                  </Row>
                  <Row label={t('admin.activePtys')} labelWidth={14}>
                    <span className="font-bold">{data.ptys?.length || 0}</span>
                    <span className="ml-1.5 text-tui-faint">{t('admin.terminalShells')}</span>
                  </Row>
                  <Row label={t('admin.uptime')} labelWidth={14}>
                    <span className="text-tui-muted">
                      {data.startTime
                        ? t('admin.startedAt', {
                            time: new Date(data.startTime).toLocaleTimeString(),
                          })
                        : t('admin.startedRecently')}
                    </span>
                  </Row>
                </Panel>

                <Panel
                  title={t('admin.throughput')}
                  aside={t('admin.perSecond', {
                    value: formatBytes(data.throughput?.bytesOutPerSec || 0),
                  })}
                  bodyClassName="space-y-0.5"
                >
                  <Row label={t('admin.bytesInTotal')} labelWidth={13}>
                    <span className="font-bold text-tui-accent">
                      {formatBytes(data.throughput?.bytesIn || 0)}
                    </span>
                    <span className="ml-1.5 text-tui-faint">
                      {t('admin.perSecond', {
                        value: formatBytes(data.throughput?.bytesInPerSec || 0),
                      })}
                    </span>
                  </Row>
                  <Row label={t('admin.bytesOutTotal')} labelWidth={13}>
                    <span className="font-bold text-tui-ok">
                      {formatBytes(data.throughput?.bytesOut || 0)}
                    </span>
                    <span className="ml-1.5 text-tui-faint">
                      {t('admin.perSecond', {
                        value: formatBytes(data.throughput?.bytesOutPerSec || 0),
                      })}
                    </span>
                  </Row>
                  <Rule />
                  <Row label={t('admin.frameRate')} labelWidth={13}>
                    <span className="font-bold">
                      {t('admin.framesPerSecond', {
                        count: (data.throughput?.framesOutPerSec || 0).toFixed(0),
                      })}
                    </span>
                  </Row>
                </Panel>
              </div>

              <HostsTable hosts={data.hosts || []} devices={data.devices} />
            </div>
          )}

          {activeTab === 'clients' && (
            <ClientsTable clients={data.clients || []} />
          )}

          {activeTab === 'ptys' && <PtysTable ptys={data.ptys || []} />}

          {activeTab === 'devices' && (
            <DevicesTable devices={data.devices || []} onRevoke={revokeDevice} />
          )}
        </>
      )}
    </AppFrame>
  );
};
