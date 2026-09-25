import React, { useState, useEffect, useCallback } from 'react';
import { AdminStatusResponse, RelayInfoResponse } from '../../types/admin';
import { useTerminal } from '../../context/TerminalContext';
import { ClientsTable } from './ClientsTable';
import { HostsTable } from './HostsTable';
import { PtysTable } from './PtysTable';
import { DevicesTable } from './DevicesTable';
import { cn } from '../../utils/cn';
import { copyText } from '../../utils/clipboard';
import { formatBytes, formatUptime } from './format';
import {
  AppFrame,
  Button,
  FieldLabel,
  GLYPH,
  Input,
  Notice,
  Panel,
  Row,
  Select,
  Sep,
  Spinner,
  StatTile,
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
  /**
   * Draw a way back on the board itself. A phone has no app header above the
   * board, so this is its only exit; a desktop has the header's `1` tab.
   */
  showBack?: boolean;
}

/** Compact controls on the board's toolbar share one height. */
const TOOLBAR_FIELD = 'h-7 py-0';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  onBackToTerminal,
  onOpenPairing,
  showBack = false,
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

  /**
   * The relay operator token for GET /api/admin/status, in two halves: what is
   * in the field, and what the board is signed in with. Only a submitted token
   * is ever sent — requesting with every keystroke put "invalid token" on
   * screen before the operator had finished typing it.
   */
  const [adminTokenInput, setAdminTokenInput] = useState(savedAdminToken);
  const [activeAdminToken, setActiveAdminToken] = useState(savedAdminToken);
  const [isOperatorView, setIsOperatorView] = useState(Boolean(savedAdminToken));

  /**
   * This page is being served by the relay it would administer. The detour
   * page that explained "this is a remote relay" and linked to its dashboard
   * then only linked back to itself, so the sign-in form is shown directly.
   */
  const isSameOriginRelay = !relayHttpBase(settings.wsUrl);

  const PAIR_COMMAND = 'node bin/service.js pair';

  useEffect(() => {
    setAdminTokenInput(savedAdminToken);
    setActiveAdminToken(savedAdminToken);
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
      // Without a submitted admin token there is nothing to ask for, and a
      // remote relay's /api/status is never requested in its place.
      if (!activeAdminToken) {
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
          'X-Relay-Admin-Token': activeAdminToken,
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
  }, [infoLoaded, isRemoteRelay, activeAdminToken, relayInfo, settings.token, settings.wsUrl, activeRelayOrigin, t]);

  /**
   * Revoke a paired device. The relay drops the stored token hash and closes
   * whatever sockets it still holds, so this refreshes straight afterwards to
   * show the client disappearing rather than waiting for the poll interval.
   */
  const revokeDevice = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(relayEndpoint(settings.wsUrl, `/api/admin/devices/${encodeURIComponent(deviceId)}`), {
        method: 'DELETE',
        headers: { Accept: 'application/json', 'X-Relay-Admin-Token': activeAdminToken },
      });
      if (!res.ok) {
        setError(t('admin.revokeFailed'));
        return;
      }
      await fetchStatus();
    } catch {
      setError(t('admin.revokeFailed'));
    }
  }, [activeAdminToken, fetchStatus, settings.wsUrl, t]);

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
    setActiveAdminToken(cleanToken);
    setIsOperatorView(Boolean(cleanToken));
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

  const version = relayInfo?.version || data?.version || '0.1.0';

  /** Hosts the pairing roster remembers but the relay has no socket for. */
  const offlineHostCount = data
    ? new Set((data.devices || []).map((device) => device.hostId).filter(
      (hostId) => hostId && !(data.hosts || []).some((host) => host.id === hostId)
    )).size
    : 0;

  const toolbarStart = showBack && onBackToTerminal ? (
    <Button
      variant="ghost"
      onClick={onBackToTerminal}
      title={t('admin.returnToTerminal')}
      aria-label={t('admin.returnToTerminal')}
      glyph={GLYPH.arrowLeft}
      brackets={false}
      className={TOOLBAR_FIELD}
    >
      <span className="sr-only">{t('admin.returnToTerminal')}</span>
    </Button>
  ) : null;

  /* The board's own controls, on the tab row: where the relay is, and how
     often to ask it. They only mean something once there is data to refresh. */
  const toolbarAside = (
    <>
      <span className="hidden items-center gap-1.5 whitespace-nowrap text-tui-sm sm:flex">
        <span className="text-tui-faint">v{version}</span>
        <Sep />
        <span className={isRemoteRelay ? 'text-tui-alt' : 'text-tui-ok'}>
          {isRemoteRelay ? t('admin.modeRemote') : t('admin.localWorkstationBadge')}
        </span>
      </span>
      {data ? (
        <>
          <label className="hidden items-center gap-1.5 text-tui-sm text-tui-muted md:flex">
            <span>{t('admin.autoRefresh')}</span>
            <Select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              aria-label={t('admin.autoRefresh')}
              className={cn('w-auto', TOOLBAR_FIELD)}
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
            className={TOOLBAR_FIELD}
          >
            {loading ? <Spinner /> : t('admin.refreshNow')}
          </Button>
        </>
      ) : null}
    </>
  );

  const showRemoteGuide = infoLoaded && isRemoteRelay && !isOperatorView && !isSameOriginRelay;
  const showOperatorSignIn = infoLoaded && isRemoteRelay && (isOperatorView || isSameOriginRelay) && !data;

  return (
    <AppFrame
      tabs={tabs}
      activeTabId={activeTab}
      onSelectTab={(id) => setActiveTab(id as typeof activeTab)}
      tabsAriaLabel={t('header.mainNavigationAria')}
      toolbarStart={toolbarStart}
      toolbarAside={toolbarAside}
      hints={[
        ...(data ? [{ keys: '1–4', action: t('admin.hintTabs') }, { keys: 'r', action: t('admin.hintRefresh') }] : []),
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

      {/* A remote relay reached through a profile on another origin: say where
          its own dashboard is, or sign in to it from here. */}
      {showRemoteGuide && (
        <Panel title={t('admin.remoteRelayTitle')} bodyClassName="space-y-2">
          <p className="text-tui leading-snug text-tui-muted">{t('admin.remoteRelayNotice')}</p>

          <div className="space-y-0.5 border border-tui-border-dim bg-tui-mantle px-2 py-1.5">
            <Row label={t('admin.remoteRelayEndpoint')} labelWidth={18}>
              <code className="break-all text-tui-accent">{settings.wsUrl}</code>
            </Row>
            <Row label={t('admin.remoteRelayAdminUrl')} labelWidth={18}>
              <code className="break-all text-tui-ok">{getRemoteAdminUrl()}</code>
            </Row>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={handleOpenRemoteAdmin} glyph={GLYPH.arrowRight}>
              {t('admin.openRemoteAdminBtn')}
            </Button>
            <Button onClick={() => setIsOperatorView(true)}>
              {t('admin.relayAdminLoginBtn')}
            </Button>
          </div>
        </Panel>
      )}

      {/* Operator sign-in for the relay-wide dashboard. */}
      {showOperatorSignIn && (
        <Panel title={t('admin.relayAdminTitle')} bodyClassName="space-y-2">
          {relayInfo?.adminConfigured === false ? (
            <Notice tone="warn">{t('admin.relayAdminNotConfigured')}</Notice>
          ) : isAuthError ? (
            <Notice tone="bad">{t('admin.relayAdminAuthError')}</Notice>
          ) : (
            <Notice tone="accent">{t('admin.relayAdminPrompt')}</Notice>
          )}

          <form onSubmit={handleSaveAdminToken} className="space-y-2">
            <div className="space-y-1">
              <FieldLabel htmlFor="relay-admin-token">
                {t('admin.relayAdminTokenLabel')}
              </FieldLabel>
              <Input
                id="relay-admin-token"
                type="password"
                autoComplete="current-password"
                value={adminTokenInput}
                onChange={(e) => setAdminTokenInput(e.target.value)}
                placeholder={t('admin.relayAdminTokenPlaceholder')}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="primary" type="submit" disabled={!adminTokenInput.trim()}>
                {t('admin.relayAdminLoginBtn')}
              </Button>
              {isSameOriginRelay ? (
                onBackToTerminal && !showBack ? (
                  <Button variant="ghost" onClick={onBackToTerminal}>
                    {t('admin.returnToTerminal')}
                  </Button>
                ) : null
              ) : (
                <Button variant="ghost" onClick={() => setIsOperatorView(false)}>
                  {t('common.cancel')}
                </Button>
              )}
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
      {infoLoaded && error && !isAuthError && (
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
          {activeTab === 'overview' && (
            <div className="space-y-3">
              {/*
               * A public relay's operator has two questions, and the board
               * answers them in that order: how much is attached and moving,
               * then who is attached to which workstation. Each figure is one
               * tile in its own colour, so the row reads at a glance; the
               * process readings that used to sit here — CPU, heap, event-loop
               * delay — describe whatever host runs the container, not the
               * service being operated, and stay off the board.
               */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                <StatTile
                  label={t('admin.connectedHosts')}
                  value={data.hosts?.length || 0}
                  sub={offlineHostCount ? t('admin.hostsOfflineSub', { count: offlineHostCount }) : undefined}
                  tone={data.hosts?.length ? 'ok' : 'idle'}
                />
                <StatTile
                  label={t('admin.activeUsers')}
                  value={activeUserCount}
                  sub={t('admin.acrossWindows', { count: data.clients?.length || 0 })}
                  tone={activeUserCount ? 'accent' : 'idle'}
                />
                <StatTile
                  label={t('admin.activePtys')}
                  value={data.ptys?.length || 0}
                  sub={t('admin.terminalShells')}
                  tone={data.ptys?.length ? 'info' : 'idle'}
                />
                <StatTile
                  label={t('admin.statInbound')}
                  value={t('admin.perSecond', { value: formatBytes(data.throughput?.bytesInPerSec || 0) })}
                  sub={t('admin.statTotal', { value: formatBytes(data.throughput?.bytesIn || 0) })}
                  tone="accent"
                />
                <StatTile
                  label={t('admin.statOutbound')}
                  value={t('admin.perSecond', { value: formatBytes(data.throughput?.bytesOutPerSec || 0) })}
                  sub={t('admin.statTotal', { value: formatBytes(data.throughput?.bytesOut || 0) })}
                  tone="ok"
                />
                <StatTile
                  label={t('admin.uptime')}
                  value={formatUptime(data.uptimeSeconds || 0, t, true)}
                  title={formatUptime(data.uptimeSeconds || 0, t)}
                  sub={data.startTime
                    ? t('admin.startedAt', { time: new Date(data.startTime).toLocaleTimeString() })
                    : t('admin.startedRecently')}
                />
              </div>

              <HostsTable hosts={data.hosts || []} devices={data.devices} clients={data.clients || []} />
            </div>
          )}

          {activeTab === 'clients' && (
            <ClientsTable clients={data.clients || []} />
          )}

          {activeTab === 'ptys' && <PtysTable ptys={data.ptys || []} />}

          {activeTab === 'devices' && (
            <DevicesTable
              devices={data.devices || []}
              clients={data.clients || []}
              onRevoke={revokeDevice}
            />
          )}
        </>
      )}
    </AppFrame>
  );
};
