// What the dashboard shows, kept fresh: the relay's description of itself,
// then its status on a timer, from the endpoint this viewer may read.

import type { AdminStatusResponse, RelayInfoResponse } from '@protocol/http';
import { useCallback, useEffect, useState } from 'react';
import type { Translate } from '@/shared/i18n';
import {
  loadRelayInfo,
  relayEndpoint,
  requestDeviceRevoke,
  requestStatus,
  type StatusResult,
} from './relayApi';

export function useRelayStatus({
  wsUrl,
  deviceToken,
  adminToken,
  relayOrigin,
  refreshInterval,
  t,
}: {
  wsUrl: string;
  /** This device's own token, for a local relay's /api/status. */
  deviceToken: string;
  /** The operator token signed in with, for a remote relay's /api/admin/status. */
  adminToken: string;
  /** Changing relay starts over. */
  relayOrigin: string;
  /** Milliseconds between polls; 0 pauses. */
  refreshInterval: number;
  t: Translate;
}) {
  const [data, setData] = useState<AdminStatusResponse | null>(null);
  const [relayInfo, setRelayInfo] = useState<RelayInfoResponse | null>(null);
  const [infoLoaded, setInfoLoaded] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts over for each relay
  useEffect(() => {
    setData(null);
    setRelayInfo(null);
    setInfoLoaded(false);
  }, [relayOrigin]);

  // 1. Fetch Relay Info metadata from unauthenticated GET /api/info FIRST
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again for each relay
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    void loadRelayInfo(wsUrl).then((info) => {
      if (!isMounted) return;
      setRelayInfo(info);
      setInfoLoaded(true);
    });
    return () => {
      isMounted = false;
    };
  }, [wsUrl, relayOrigin]);

  const isRemoteRelay = relayInfo?.relayMode === 'remote';

  const showResult = useCallback((result: StatusResult, deniedMessage: string) => {
    if (result.kind === 'denied') {
      setIsAuthError(true);
      setError(deniedMessage);
      setData(null);
      return;
    }
    setData(result.data);
    setError(null);
    setIsAuthError(false);
    setLastUpdated(new Date());
  }, []);

  const showFailure = useCallback((err: unknown, fallback: string) => {
    setIsAuthError(false);
    setError(err instanceof Error ? err.message : fallback);
    setData(null);
  }, []);

  // 2. Fetch status strictly respecting local vs remote boundary
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new relay needs a new request
  const fetchStatus = useCallback(async () => {
    if (!infoLoaded) return;

    // Case A: REMOTE relay
    if (isRemoteRelay) {
      // Without a submitted admin token there is nothing to ask for, and a
      // remote relay's /api/status is never requested in its place.
      if (!adminToken) {
        setData(null);
        setLoading(false);
        setError(null);
        setIsAuthError(false);
        return;
      }
      // Remote operator mode: strictly request GET /api/admin/status with X-Relay-Admin-Token
      try {
        setLoading(true);
        const result = await requestStatus(
          relayEndpoint(wsUrl, relayInfo?.adminStatusPath || '/api/admin/status'),
          { 'X-Relay-Admin-Token': adminToken },
        );
        showResult(result, t('admin.relayAdminAuthError'));
      } catch (err) {
        console.warn('GET /api/admin/status request failed:', err);
        showFailure(err, 'Failed to fetch remote admin status');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Case B: LOCAL relay (run by herdr-remote on local machine)
    try {
      setLoading(true);
      const result = await requestStatus(
        '/api/status',
        deviceToken ? { Authorization: `Bearer ${deviceToken}` } : {},
      );
      showResult(
        result,
        result.kind === 'denied'
          ? `Authentication failed (HTTP ${result.status}): Access denied. Please configure an authorized token or pair with the host.`
          : '',
      );
    } catch (err) {
      console.warn('GET /api/status request failed:', err);
      showFailure(err, 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [infoLoaded, isRemoteRelay, adminToken, relayInfo, deviceToken, wsUrl, relayOrigin, t]);

  /**
   * Revoke a paired device, then refresh straight away to show its client
   * disappearing rather than waiting for the poll interval.
   */
  const revokeDevice = useCallback(
    async (deviceId: string) => {
      try {
        if (!(await requestDeviceRevoke(wsUrl, adminToken, deviceId))) {
          setError(t('admin.revokeFailed'));
          return;
        }
        await fetchStatus();
      } catch {
        setError(t('admin.revokeFailed'));
      }
    },
    [adminToken, fetchStatus, wsUrl, t],
  );

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

  return {
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
  };
}
