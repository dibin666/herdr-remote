// The relay row on the About tab: check for, install and switch to a newer
// relay. Only a machine that runs its own relay has one to update.

import { useEffect, useState } from 'react';
import type { AppContext } from '../App.js';
import {
  canSelfUpdate,
  checkForRelayUpdate,
  compareVersions,
  currentVersion,
  installKind,
  installedRelayVersion,
  performRelayUpdate,
  type RelayUpdateCheck,
  restartAll,
  runsLocalRelay,
  whileServicesStopped,
} from '../api.js';

type RelayUpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; version: string }
  | { phase: 'available'; latest: string }
  | { phase: 'needsCli'; latest: string }
  | { phase: 'updating'; latest: string; attempt: number }
  | { phase: 'restarting' }
  | { phase: 'error'; messageKey: string; params?: Record<string, string | number> };

export function useRelayUpdate(ctx: AppContext) {
  const { t } = ctx;
  const [state, setState] = useState<RelayUpdateState>({ phase: 'idle' });
  const [source, setSource] = useState<{ registry: string; sources: string[] }>({
    registry: '',
    sources: [],
  });
  const visible = runsLocalRelay(ctx.config);
  const installed = installedRelayVersion();
  const health = ctx.status?.relay.health;
  const running = typeof health?.version === 'string' ? health.version : null;
  const busy = state.phase === 'checking' || state.phase === 'updating';
  // Installed but not yet running: an update from here, or from npm by hand.
  const restartNeeded =
    !busy &&
    state.phase !== 'restarting' &&
    !!installed &&
    !!running &&
    compareVersions(installed, running) > 0;

  const applyCheck = (result: RelayUpdateCheck) => {
    setSource({ registry: result.registry ?? '', sources: result.sources ?? [] });
    const latest = result.latest as string;
    if (result.needsNewerCli) setState({ phase: 'needsCli', latest });
    else if (result.updateAvailable) setState({ phase: 'available', latest });
    else setState({ phase: 'current', version: result.current });
  };

  // The TUI asked when it opened; start from that answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new answer from the opening check matters, not each render's applyCheck or phase
  useEffect(() => {
    if (ctx.relayUpdateCheck?.ok && state.phase === 'idle') applyCheck(ctx.relayUpdateCheck);
  }, [ctx.relayUpdateCheck]);

  const check = async () => {
    setState({ phase: 'checking' });
    const result = await checkForRelayUpdate();
    if (!result.ok) {
      setState({ phase: 'error', messageKey: result.errorKey ?? 'update.errorNetwork' });
      const { message } = result;
      if (message) ctx.notify((t) => t('update.errorNetworkDetail', { message }), 'error');
      return;
    }
    ctx.setRelayUpdateCheck(result);
    applyCheck(result);
  };

  const install = async (latest: string) => {
    setState({ phase: 'updating', latest, attempt: 1 });
    const result = await whileServicesStopped(ctx.config, () =>
      performRelayUpdate({
        ...source,
        relayVersion: latest,
        onAttempt: ({ attempt }: { attempt: number }) =>
          setState({ phase: 'updating', latest, attempt }),
      }),
    );
    if (!result.ok) {
      const params = { version: currentVersion(), installed: result.installed ?? '' };
      const messageKey = result.errorKey ?? 'update.errorFailed';
      setState({ phase: 'error', messageKey, params });
      const { summary } = result;
      ctx.notify(
        (t) =>
          summary ? t('update.errorFailedDetail', { message: summary }) : t(messageKey, params),
        'error',
      );
      return;
    }
    ctx.setRelayUpdateCheck(null);
    setState({ phase: 'current', version: latest });
  };

  const restart = () => {
    setState({ phase: 'restarting' });
    ctx.run(() => {
      restartAll(ctx.config);
      const version = installed ?? '';
      setState({ phase: 'current', version });
      ctx.notify((t) => t('relayUpdate.restarted', { version }), 'success');
    });
  };

  /** One row: restart onto a relay already installed, install one found, or check. */
  const activate = () => {
    if (busy || state.phase === 'restarting') return;
    if (restartNeeded) {
      restart();
      return;
    }
    if (state.phase === 'available') {
      if (!canSelfUpdate()) {
        setState({ phase: 'error', messageKey: `update.cannot.${installKind()}` });
        return;
      }
      void install(state.latest);
      return;
    }
    void check();
  };

  const label = (() => {
    if (restartNeeded)
      return t('relayUpdate.restart', { version: installed ?? '', running: running ?? '' });
    switch (state.phase) {
      case 'checking':
        return t('relayUpdate.checking');
      case 'current':
        return t('relayUpdate.upToDate', { version: state.version });
      case 'available':
        return t('relayUpdate.available', { latest: state.latest, installed: installed ?? '?' });
      case 'needsCli':
        return t('relayUpdate.needsCli', { latest: state.latest });
      case 'updating':
        return state.attempt > 1
          ? t('relayUpdate.updatingRetry', { version: state.latest, attempt: state.attempt })
          : t('relayUpdate.updating', { version: state.latest });
      case 'restarting':
        return t('relayUpdate.restarting');
      case 'error':
        return t(state.messageKey, state.params);
      default:
        return t('relayUpdate.check', { version: installed ?? '?' });
    }
  })();

  return { visible, installed, label, activate };
}
