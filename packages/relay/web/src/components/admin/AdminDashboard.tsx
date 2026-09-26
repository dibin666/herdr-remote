import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettings } from '../../context/TerminalContext';
import { cn } from '../../utils/cn';
import { AppFrame, Button, GLYPH, Notice, Select, Sep, Spinner } from '../tui';
import { OperatorSignIn, RemoteRelayGuide, UnauthorizedPanel } from './AccessPanels';
import { ClientsTable } from './ClientsTable';
import { DevicesTable } from './DevicesTable';
import { OverviewTab } from './OverviewTab';
import { PtysTable } from './PtysTable';
import { relayHttpBase, remoteAdminUrl } from './relayApi';
import { useRelayStatus } from './useRelayStatus';

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
  const { settings, updateSettings, t } = useSettings();
  const activeRelayOrigin =
    relayHttpBase(settings.wsUrl) ||
    (typeof window !== 'undefined' ? window.location.origin : 'local');
  const savedAdminToken =
    settings.adminTokens?.[activeRelayOrigin] ||
    (activeRelayOrigin === (typeof window !== 'undefined' ? window.location.origin : 'local')
      ? settings.adminToken
      : '') ||
    '';
  const [refreshInterval, setRefreshInterval] = useState<number>(3000); // 3 seconds
  const [activeTab, setActiveTab] = useState<'overview' | 'clients' | 'ptys' | 'devices'>(
    'overview',
  );

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different relay has a different token
  useEffect(() => {
    setAdminTokenInput(savedAdminToken);
    setActiveAdminToken(savedAdminToken);
    setIsOperatorView(Boolean(savedAdminToken));
  }, [activeRelayOrigin]);

  const {
    data,
    relayInfo,
    infoLoaded,
    isRemoteRelay,
    loading,
    error,
    isAuthError,
    lastUpdated,
    fetchStatus,
    revokeDevice,
  } = useRelayStatus({
    wsUrl: settings.wsUrl,
    deviceToken: settings.token,
    adminToken: activeAdminToken,
    relayOrigin: activeRelayOrigin,
    refreshInterval,
    t,
  });

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

  const adminUrl = remoteAdminUrl(relayInfo, data, settings.wsUrl);

  const tabs = data
    ? [
        { id: 'overview', label: t('admin.tabOverview'), index: 1 },
        {
          id: 'clients',
          label: t('admin.tabClients', { count: data.clients?.length || 0 }),
          index: 2,
        },
        { id: 'ptys', label: t('admin.tabPtys', { count: data.ptys?.length || 0 }), index: 3 },
        // The roster only exists in the operator response, so the tab only
        // exists once this dashboard is authenticated as the operator.
        ...(data.devices
          ? [
              {
                id: 'devices',
                label: t('admin.tabDevices', { count: data.devices.length }),
                index: 4,
              },
            ]
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

  const toolbarStart =
    showBack && onBackToTerminal ? (
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
  const showOperatorSignIn =
    infoLoaded && isRemoteRelay && (isOperatorView || isSameOriginRelay) && !data;

  return (
    <AppFrame
      tabs={tabs}
      activeTabId={activeTab}
      onSelectTab={(id) => setActiveTab(id as typeof activeTab)}
      tabsAriaLabel={t('header.mainNavigationAria')}
      toolbarStart={toolbarStart}
      toolbarAside={toolbarAside}
      hints={[
        ...(data
          ? [
              { keys: '1–4', action: t('admin.hintTabs') },
              { keys: 'r', action: t('admin.hintRefresh') },
            ]
          : []),
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
        <RemoteRelayGuide
          wsUrl={settings.wsUrl}
          adminUrl={adminUrl}
          onOpenRemoteAdmin={() => window.open(adminUrl, '_blank', 'noopener,noreferrer')}
          onSignIn={() => setIsOperatorView(true)}
        />
      )}

      {showOperatorSignIn && (
        <OperatorSignIn
          adminConfigured={relayInfo?.adminConfigured}
          isAuthError={isAuthError}
          tokenInput={adminTokenInput}
          onTokenInput={setAdminTokenInput}
          onSubmit={handleSaveAdminToken}
          isSameOriginRelay={isSameOriginRelay}
          onBackToTerminal={onBackToTerminal}
          showBack={showBack}
          onCancel={() => setIsOperatorView(false)}
        />
      )}

      {infoLoaded && !isRemoteRelay && isAuthError && (
        <UnauthorizedPanel onOpenPairing={onOpenPairing} onRetry={fetchStatus} />
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
          {activeTab === 'overview' && <OverviewTab data={data} />}

          {activeTab === 'clients' && <ClientsTable clients={data.clients || []} />}

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
