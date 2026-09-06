import React, { useState, useEffect, useCallback } from 'react';
import { AdminStatusResponse, RelayInfoResponse } from '../../types/admin';
import { useTerminal } from '../../context/TerminalContext';
import { StatCard } from './StatCard';
import { MetricGauge } from './MetricGauge';
import { ClientsTable } from './ClientsTable';
import { PtysTable } from './PtysTable';
import { RawStatusViewer } from './RawStatusViewer';
import {
  Users,
  ShieldAlert,
  Terminal,
  Activity,
  Cpu,
  Database,
  Timer,
  RefreshCw,
  Clock,
  ArrowUpDown,
  CheckCircle2,
  AlertCircle,
  Trash2,
  ChevronLeft,
  KeyRound,
  Lock,
  Copy,
  Check,
  ExternalLink,
  Radio,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '../../utils/cn';

interface AdminDashboardProps {
  onBackToTerminal?: () => void;
  onOpenPairing?: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  onBackToTerminal,
  onOpenPairing,
}) => {
  const { settings, updateSettings, addToast, t } = useTerminal();
  const [data, setData] = useState<AdminStatusResponse | null>(null);
  const [relayInfo, setRelayInfo] = useState<RelayInfoResponse | null>(null);
  const [infoLoaded, setInfoLoaded] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);
  const [refreshInterval, setRefreshInterval] = useState<number>(3000); // 3 seconds
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'clients' | 'ptys'>('overview');
  const [copiedPairCmd, setCopiedPairCmd] = useState(false);

  // Relay Operator Token for GET /api/admin/status
  const [adminTokenInput, setAdminTokenInput] = useState(settings.adminToken || '');
  const [isOperatorView, setIsOperatorView] = useState(Boolean(settings.adminToken));

  const PAIR_COMMAND = 'node bin/service.js pair';

  const handleCopyPairCmd = () => {
    navigator.clipboard.writeText(PAIR_COMMAND).then(() => {
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
        const res = await fetch('/api/info', {
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
  }, [settings.wsUrl]);

  const isRemoteRelay = relayInfo?.relayMode === 'remote';

  // Derives remote admin URL
  const getRemoteAdminUrl = (): string => {
    if (relayInfo?.adminPath) {
      if (relayInfo.publicUrl) {
        return `${relayInfo.publicUrl.replace(/\/$/, '')}${relayInfo.adminPath}`;
      }
      return relayInfo.adminPath;
    }
    if (data?.remoteAdminUrl) return data.remoteAdminUrl;
    if (settings.wsUrl) {
      try {
        const url = new URL(settings.wsUrl.replace(/^ws/, 'http'));
        return `${url.origin}/admin`;
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
        const targetEndpoint = relayInfo?.adminStatusPath || '/api/admin/status';
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
  }, [infoLoaded, isRemoteRelay, isOperatorView, adminTokenInput, relayInfo, settings.token, t]);

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
    updateSettings({ adminToken: cleanToken });
    setIsOperatorView(true);
  };

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
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

  return (
    <div className="flex-1 w-full overflow-y-auto bg-sand-100 dark:bg-charcoal-950 p-3 sm:p-6 space-y-6 pb-20">
      {/* Top Header & Refresh Control */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 shadow-sm">
        <div className="flex items-center gap-3">
          {onBackToTerminal && (
            <button
              type="button"
              onClick={onBackToTerminal}
              className="p-2 rounded-xl bg-sand-100 hover:bg-sand-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-charcoal-700 dark:text-charcoal-200 border border-sand-300 dark:border-charcoal-700 transition-colors"
              title={t('admin.returnToTerminal')}
              aria-label={t('admin.returnToTerminal')}
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <div className="w-10 h-10 rounded-xl bg-herdr-100 dark:bg-herdr-950 border border-herdr-300 dark:border-herdr-700 flex items-center justify-center text-herdr-600 dark:text-herdr-400 shadow-sm">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-charcoal-900 dark:text-charcoal-100 flex items-center gap-2">
              {t('admin.title')}
              <span className="text-xs font-mono font-normal px-2 py-0.5 rounded-full bg-sand-100 dark:bg-charcoal-800 text-herdr-700 dark:text-herdr-300 border border-sand-300 dark:border-charcoal-700">
                v{relayInfo?.version || data?.version || '0.1.0'}
              </span>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-sand-200 dark:bg-charcoal-800 text-charcoal-700 dark:text-charcoal-300 border border-sand-300 dark:border-charcoal-700 font-sans">
                {isRemoteRelay ? t('admin.modeRemote') : t('admin.localWorkstationBadge')}
              </span>
            </h1>
            <p className="text-xs text-charcoal-500 dark:text-charcoal-400 flex items-center gap-2 mt-0.5">
              <span>{t('admin.subtitle')}</span>
              {lastUpdated && (
                <span className="text-charcoal-400 dark:text-charcoal-500 font-mono text-[11px]">
                  • {t('admin.updatedAt', { time: lastUpdated.toLocaleTimeString() })}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Refresh interval selector */}
          <div className="flex items-center bg-sand-50 dark:bg-charcoal-900 rounded-xl border border-sand-300 dark:border-charcoal-700 p-1 text-xs">
            <span className="text-charcoal-500 dark:text-charcoal-400 px-2 font-medium">{t('admin.autoRefresh')}</span>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="bg-paper dark:bg-charcoal-800 text-charcoal-800 dark:text-charcoal-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-herdr-500 text-xs cursor-pointer border border-sand-200 dark:border-charcoal-700"
            >
              <option value={0}>{t('admin.paused')}</option>
              <option value={1000}>1s</option>
              <option value={3000}>3s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
            </select>
          </div>

          <button
            type="button"
            onClick={fetchStatus}
            disabled={loading}
            className="p-2.5 rounded-xl bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white font-medium transition-colors disabled:opacity-50 shadow-sm flex items-center gap-1.5 text-xs cursor-pointer"
            title={t('admin.refreshNow')}
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            <span className="hidden sm:inline">{t('admin.refreshNow')}</span>
          </button>
        </div>
      </div>

      {/* Loading state before info is determined */}
      {!infoLoaded && (
        <div className="p-12 text-center text-charcoal-500 dark:text-charcoal-400 text-xs flex flex-col items-center justify-center gap-2 bg-paper dark:bg-charcoal-850 rounded-2xl border border-sand-300 dark:border-charcoal-700 shadow-sm">
          <RefreshCw className="w-6 h-6 animate-spin text-herdr-600 dark:text-herdr-400" />
          <span>{t('admin.loadingStatus')}</span>
        </div>
      )}

      {/* Remote Relay Connected Guidance View (when in client view, not operator mode) */}
      {infoLoaded && isRemoteRelay && !isOperatorView && (
        <div className="bg-paper dark:bg-charcoal-850 border-2 border-herdr-200 dark:border-herdr-900/60 rounded-2xl p-6 text-xs text-charcoal-800 dark:text-charcoal-200 shadow-md space-y-4 animate-in fade-in">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-xl bg-herdr-50 dark:bg-herdr-950/80 border border-herdr-200 dark:border-herdr-800 text-herdr-600 dark:text-herdr-400 shadow-sm">
              <Radio className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm sm:text-base text-charcoal-900 dark:text-charcoal-100">
                  {t('admin.remoteRelayTitle')}
                </h3>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-herdr-100 dark:bg-herdr-900/50 text-herdr-700 dark:text-herdr-300 border border-herdr-200 dark:border-herdr-700">
                  {t('admin.remoteRelayBadge')}
                </span>
              </div>
              <p className="mt-1.5 text-charcoal-600 dark:text-charcoal-300 leading-relaxed">
                {t('admin.remoteRelayNotice')}
              </p>
            </div>
          </div>

          <div className="bg-sand-50 dark:bg-charcoal-900 rounded-xl p-4 border border-sand-200 dark:border-charcoal-750 space-y-2 text-xs font-mono">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-charcoal-700 dark:text-charcoal-300">
              <span className="font-semibold text-charcoal-500 font-sans">{t('admin.remoteRelayEndpoint')}</span>
              <code className="text-herdr-700 dark:text-herdr-400">{settings.wsUrl}</code>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-charcoal-700 dark:text-charcoal-300">
              <span className="font-semibold text-charcoal-500 font-sans">{t('admin.remoteRelayAdminUrl')}</span>
              <code className="text-emerald-700 dark:text-emerald-400">{getRemoteAdminUrl()}</code>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-sand-200 dark:border-charcoal-750">
            <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 leading-relaxed">
              {t('admin.remoteRelayHelp')}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsOperatorView(true)}
                className="px-3.5 py-2 bg-sand-200 hover:bg-sand-300 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-charcoal-800 dark:text-charcoal-200 rounded-xl text-xs font-medium transition-colors"
              >
                {t('admin.relayAdminLoginBtn')}
              </button>
              <button
                type="button"
                onClick={handleOpenRemoteAdmin}
                className="px-4 py-2.5 bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm shrink-0"
              >
                <ExternalLink className="w-4 h-4" />
                <span>{t('admin.openRemoteAdminBtn')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Operator Relay Admin Token Authentication Card (when in operator view and unauthenticated) */}
      {infoLoaded && isRemoteRelay && isOperatorView && !data && (
        <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-6 text-xs text-charcoal-800 dark:text-charcoal-200 shadow-md space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-xl bg-herdr-50 dark:bg-herdr-950/80 border border-herdr-200 dark:border-herdr-800 text-herdr-600 dark:text-herdr-400 shadow-sm">
              <Server className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-sm sm:text-base text-charcoal-900 dark:text-charcoal-100">
                {t('admin.relayAdminTitle')}
              </h3>
              <p className="mt-1 text-charcoal-600 dark:text-charcoal-300 leading-relaxed">
                {relayInfo?.adminConfigured === false
                  ? t('admin.relayAdminNotConfigured')
                  : t('admin.relayAdminAuthError')}
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveAdminToken} className="space-y-3 pt-2">
            <div>
              <label className="block text-charcoal-700 dark:text-charcoal-300 font-semibold mb-1">
                {t('admin.relayAdminTokenLabel')}
              </label>
              <input
                type="password"
                value={adminTokenInput}
                onChange={(e) => setAdminTokenInput(e.target.value)}
                placeholder={t('admin.relayAdminTokenPlaceholder')}
                className="w-full bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl px-3.5 py-2.5 text-charcoal-900 dark:text-charcoal-100 font-mono text-xs focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
              />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                className="px-4 py-2 bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{t('admin.relayAdminLoginBtn')}</span>
              </button>
              <button
                type="button"
                onClick={() => setIsOperatorView(false)}
                className="px-3.5 py-2 bg-sand-200 hover:bg-sand-300 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-charcoal-700 dark:text-charcoal-300 rounded-xl text-xs transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Authentication Error / First-Run Guidance Card (for local host device token) */}
      {infoLoaded && !isRemoteRelay && isAuthError && (
        <div className="bg-paper dark:bg-charcoal-850 border-2 border-red-200 dark:border-red-900/60 rounded-2xl p-6 text-xs text-charcoal-800 dark:text-charcoal-200 shadow-lg space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 shadow-sm">
              <Lock className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-sm sm:text-base text-charcoal-900 dark:text-red-200">
                {t('admin.unauthorizedTitle')}
              </h3>
              <p className="mt-1 text-charcoal-600 dark:text-charcoal-300 leading-relaxed">
                {t('admin.unauthorizedDesc')}
              </p>
            </div>
          </div>

          {/* Actionable Pairing Steps Box */}
          <div className="bg-sand-50 dark:bg-charcoal-900 rounded-xl p-4 border border-sand-200 dark:border-charcoal-750 space-y-2.5">
            <span className="font-semibold text-charcoal-700 dark:text-charcoal-200 block">
              {t('admin.pairingStepsTitle')}
            </span>
            <div className="flex items-center gap-2 bg-paper dark:bg-charcoal-950 border border-sand-300 dark:border-charcoal-700 rounded-lg p-2 font-mono text-xs">
              <code className="flex-1 text-charcoal-800 dark:text-charcoal-200 truncate">
                {PAIR_COMMAND}
              </code>
              <button
                type="button"
                onClick={handleCopyPairCmd}
                className="px-2.5 py-1 rounded bg-sand-100 hover:bg-sand-200 dark:bg-charcoal-800 text-charcoal-700 dark:text-charcoal-200 text-xs flex items-center gap-1 border border-sand-300 dark:border-charcoal-700 shrink-0 font-sans"
              >
                {copiedPairCmd ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{t('admin.copiedJson')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('common.copy')}</span>
                  </>
                )}
              </button>
            </div>
            <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400">
              {t('admin.pairingStepsHelp')}
            </p>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-sand-200 dark:border-charcoal-750">
            {onOpenPairing && (
              <button
                type="button"
                onClick={onOpenPairing}
                className="px-4 py-2 bg-herdr-700 hover:bg-herdr-800 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 transition-colors shadow-sm"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>{t('admin.enterPairCodeBtn')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={fetchStatus}
              className="px-3.5 py-2 bg-sand-200 hover:bg-sand-300 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 rounded-xl text-xs font-medium text-charcoal-700 dark:text-charcoal-200 transition-colors"
            >
              {t('admin.retryFetchBtn')}
            </button>
          </div>
        </div>
      )}

      {/* General Error Banner (non-auth, when not in remote guidance) */}
      {infoLoaded && error && !isAuthError && !(!isRemoteRelay && isAuthError) && (
        <div className="bg-amber-50 dark:bg-amber-950/70 border border-amber-300 dark:border-amber-700 rounded-2xl p-4 flex items-center justify-between text-xs text-amber-900 dark:text-amber-200 shadow-sm">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <span>
              {t('admin.errorConnecting', { error })}
            </span>
          </div>
          <button
            type="button"
            onClick={fetchStatus}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-700 rounded-lg text-xs font-semibold text-white transition-colors flex-shrink-0 ml-3"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Display Live Dashboard Data when Available */}
      {data && (
        <>
          {/* Top High-level Metric Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              title={t('admin.activeClients')}
              value={data.clients?.length || 0}
              subtitle={`${data.clients?.filter((c) => c.role === 'controller').length || 0} ${t('common.role')}`}
              icon={<Users className="w-5 h-5" />}
              trend={t('admin.liveTrend')}
              trendType="positive"
            />

            <StatCard
              title={t('admin.activePtys')}
              value={data.ptys?.length || 0}
              subtitle={t('admin.terminalShells')}
              icon={<Terminal className="w-5 h-5" />}
            />

            <StatCard
              title={t('admin.activeController')}
              value={data.activeControllerId || t('admin.none')}
              subtitle={data.activeHostId ? `${t('common.host')}: ${data.activeHostId}` : t('admin.noHost')}
              icon={<ShieldAlert className="w-5 h-5" />}
              className={data.activeControllerId ? 'border-emerald-500/40' : undefined}
            />

            <StatCard
              title={t('admin.uptime')}
              value={formatUptime(data.uptimeSeconds || 0)}
              subtitle={data.startTime ? t('admin.startedAt', { time: new Date(data.startTime).toLocaleTimeString() }) : t('admin.startedRecently')}
              icon={<Clock className="w-5 h-5" />}
            />
          </div>

          {/* Navigation tabs for admin sections */}
          <div className="flex items-center gap-2 border-b border-sand-300 dark:border-charcoal-700 pb-1 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={cn(
                'px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5',
                activeTab === 'overview'
                  ? 'bg-herdr-700 text-white shadow-sm'
                  : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-200 dark:hover:bg-charcoal-800'
              )}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>{t('admin.tabOverview')}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('clients')}
              className={cn(
                'px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5',
                activeTab === 'clients'
                  ? 'bg-herdr-700 text-white shadow-sm'
                  : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-200 dark:hover:bg-charcoal-800'
              )}
            >
              <Users className="w-3.5 h-3.5" />
              <span>{t('admin.tabClients', { count: data.clients?.length || 0 })}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ptys')}
              className={cn(
                'px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5',
                activeTab === 'ptys'
                  ? 'bg-herdr-700 text-white shadow-sm'
                  : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-200 dark:hover:bg-charcoal-800'
              )}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{t('admin.tabPtys', { count: data.ptys?.length || 0 })}</span>
            </button>
          </div>

          {/* Tab: Overview */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Detailed Resource Metrics Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* CPU & Load */}
                <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-sand-200 dark:border-charcoal-750 pb-2">
                    <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-herdr-500" />
                      <span>{t('admin.cpuAndLoad')}</span>
                    </span>
                    <span className="text-[11px] font-mono text-charcoal-500 dark:text-charcoal-400">
                      {t('admin.cores', { count: data.cpu?.cores || 1 })}
                    </span>
                  </div>

                  <MetricGauge
                    label={t('admin.cpuUtilization')}
                    value={data.cpu?.cpuPercent || 0}
                    displayValue={`${(data.cpu?.cpuPercent || 0).toFixed(1)}%`}
                    color="herdr"
                  />

                  <div className="pt-2 border-t border-sand-200 dark:border-charcoal-750 grid grid-cols-3 gap-2 text-center">
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.load1m')}</span>
                      <span className="font-mono font-semibold text-xs text-charcoal-800 dark:text-charcoal-200">
                        {(data.cpu?.load1m || 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.load5m')}</span>
                      <span className="font-mono font-semibold text-xs text-charcoal-800 dark:text-charcoal-200">
                        {(data.cpu?.load5m || 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.load15m')}</span>
                      <span className="font-mono font-semibold text-xs text-charcoal-800 dark:text-charcoal-200">
                        {(data.cpu?.load15m || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Memory Utilization */}
                <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-sand-200 dark:border-charcoal-750 pb-2">
                    <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
                      <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>{t('admin.memory')}</span>
                    </span>
                    <span className="text-[11px] font-mono text-charcoal-500 dark:text-charcoal-400">
                      RSS: {formatBytes(data.memory?.rssBytes || 0)}
                    </span>
                  </div>

                  {(() => {
                    const used = data.memory?.heapUsedBytes || 0;
                    const total = data.memory?.heapTotalBytes || 1;
                    const pct = total > 0 ? (used / total) * 100 : 0;
                    return (
                      <MetricGauge
                        label={t('admin.heapUtilization')}
                        value={pct}
                        displayValue={`${formatBytes(used)} / ${formatBytes(total)}`}
                        detail={`Process RSS: ${formatBytes(data.memory?.rssBytes || 0)}`}
                        color="emerald"
                      />
                    );
                  })()}

                  <div className="pt-2 border-t border-sand-200 dark:border-charcoal-750 flex items-center justify-between text-[11px] text-charcoal-500 dark:text-charcoal-400 font-mono">
                    <span>{t('admin.external')}</span>
                    <span className="text-charcoal-800 dark:text-charcoal-200 font-semibold">
                      {formatBytes(data.memory?.externalBytes || 0)}
                    </span>
                  </div>
                </div>

                {/* Event Loop Delay */}
                <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-sand-200 dark:border-charcoal-750 pb-2">
                    <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
                      <Timer className="w-4 h-4 text-amber-500" />
                      <span>{t('admin.eventLoopDelay')}</span>
                    </span>
                    <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold">
                      <CheckCircle2 className="w-3 h-3" /> {t('admin.liveTrend')}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center pt-1">
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.metricP50')}</span>
                      <span className="font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">
                        {(data.eventLoopDelay?.p50Ms || 0).toFixed(1)}ms
                      </span>
                    </div>
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.metricP99')}</span>
                      <span className="font-mono font-bold text-xs text-amber-600 dark:text-amber-400">
                        {(data.eventLoopDelay?.p99Ms || 0).toFixed(1)}ms
                      </span>
                    </div>
                    <div className="bg-sand-50 dark:bg-charcoal-900 p-2 rounded-xl border border-sand-200 dark:border-charcoal-750">
                      <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 block uppercase">{t('admin.metricMax')}</span>
                      <span className="font-mono font-bold text-xs text-herdr-600 dark:text-herdr-400">
                        {(data.eventLoopDelay?.maxMs || 0).toFixed(1)}ms
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 leading-relaxed">
                    {t('admin.eventLoopDesc')}
                  </p>
                </div>

                {/* Network Throughput */}
                <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-sand-200 dark:border-charcoal-750 pb-2">
                    <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
                      <ArrowUpDown className="w-4 h-4 text-herdr-500" />
                      <span>{t('admin.throughput')}</span>
                    </span>
                    <span className="text-[11px] font-mono text-herdr-700 dark:text-herdr-400 font-semibold">
                      {formatBytes(data.throughput?.bytesOutPerSec || 0)}/s
                    </span>
                  </div>

                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex justify-between text-charcoal-700 dark:text-charcoal-300">
                      <span>{t('admin.bytesInTotal')}</span>
                      <span className="text-herdr-700 dark:text-herdr-300 font-semibold">
                        {formatBytes(data.throughput?.bytesIn || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between text-charcoal-700 dark:text-charcoal-300">
                      <span>{t('admin.bytesOutTotal')}</span>
                      <span className="text-emerald-700 dark:text-emerald-300 font-semibold">
                        {formatBytes(data.throughput?.bytesOut || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between text-charcoal-700 dark:text-charcoal-300">
                      <span>{t('admin.frameRate')}</span>
                      <span className="text-charcoal-900 dark:text-charcoal-100 font-semibold">
                        {(data.throughput?.framesOutPerSec || 0).toFixed(0)} fps
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Cleanup Counters & Maintenance */}
              <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-sand-200 dark:border-charcoal-750 pb-3 mb-3">
                  <h3 className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5 text-amber-500" />
                    <span>{t('admin.gcCleanup')}</span>
                  </h3>
                  {data.cleanup?.lastCleanupAt && (
                    <span className="text-[11px] font-mono text-charcoal-500">
                      Last: {new Date(data.cleanup.lastCleanupAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                  <div className="bg-sand-50 dark:bg-charcoal-900 p-3 rounded-xl border border-sand-200 dark:border-charcoal-750">
                    <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 uppercase block">{t('admin.staleClientsPurged')}</span>
                    <span className="font-mono text-base font-bold text-charcoal-900 dark:text-charcoal-100 mt-1 block">
                      {data.cleanup?.staleClientsPurged || 0}
                    </span>
                  </div>
                  <div className="bg-sand-50 dark:bg-charcoal-900 p-3 rounded-xl border border-sand-200 dark:border-charcoal-750">
                    <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 uppercase block">{t('admin.closedPtysCleaned')}</span>
                    <span className="font-mono text-base font-bold text-charcoal-900 dark:text-charcoal-100 mt-1 block">
                      {data.cleanup?.closedPtysCleaned || 0}
                    </span>
                  </div>
                  <div className="bg-sand-50 dark:bg-charcoal-900 p-3 rounded-xl border border-sand-200 dark:border-charcoal-750">
                    <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 uppercase block">{t('admin.deadConnections')}</span>
                    <span className="font-mono text-base font-bold text-charcoal-900 dark:text-charcoal-100 mt-1 block">
                      {data.cleanup?.deadConnectionsClosed || 0}
                    </span>
                  </div>
                  <div className="bg-sand-50 dark:bg-charcoal-900 p-3 rounded-xl border border-sand-200 dark:border-charcoal-750">
                    <span className="text-[10px] text-charcoal-500 dark:text-charcoal-400 uppercase block">{t('admin.idleHostsTerminated')}</span>
                    <span className="font-mono text-base font-bold text-charcoal-900 dark:text-charcoal-100 mt-1 block">
                      {data.cleanup?.idleHostsTerminated || 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* Clients and PTYs Tables */}
              <div className="grid grid-cols-1 gap-6">
                <ClientsTable
                  clients={data.clients || []}
                  activeControllerId={data.activeControllerId}
                />
                <PtysTable ptys={data.ptys || []} />
              </div>

              {/* Raw JSON viewer */}
              <RawStatusViewer data={data} />
            </div>
          )}

          {/* Tab: Clients */}
          {activeTab === 'clients' && (
            <div className="space-y-4">
              <ClientsTable
                clients={data.clients || []}
                activeControllerId={data.activeControllerId}
              />
            </div>
          )}

          {/* Tab: PTYs */}
          {activeTab === 'ptys' && (
            <div className="space-y-4">
              <PtysTable ptys={data.ptys || []} />
            </div>
          )}
        </>
      )}
    </div>
  );
};
