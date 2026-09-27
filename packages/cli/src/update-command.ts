// `herdr-remote update`: install the newest release and restart what was running.
//
// The TUI's update row installs and leaves the restart to a second key press;
// a command run over SSH or from a script has nobody to press it. The restart
// is run by the release just installed, not by this process: this process
// still runs the old code, and would start the services as the old release
// described them.

import { spawnSync } from 'node:child_process';
import { type Config, loadConfig } from './config.js';
import {
  startAdminBrokerTask,
  stopAdminBroker,
  waitForAdminBroker,
} from './connector/admin-broker.js';
import type { Translate } from './i18n/index.js';
import { cliEntryPoint } from './keepalive/environment.js';
import { servicesRunning, startAll, stopAll } from './lifecycle.js';
import { checkForRelayUpdate, performRelayUpdate, type RelayUpdateCheck } from './relay-updater.js';
import { checkForUpdate, performUpdate, type UpdateCheck } from './updater.js';

const RESTART_TIMEOUT_MS = 120_000;

type InstallResult = Awaited<ReturnType<typeof performUpdate>>;
type OnAttempt = (progress: { attempt: number }) => void;

interface UpdateOptions {
  config?: Config;
  platform?: NodeJS.Platform;
  checkCli?: () => Promise<UpdateCheck>;
  checkRelay?: () => Promise<RelayUpdateCheck>;
  installCli?: (check: UpdateCheck, onAttempt: OnAttempt) => Promise<InstallResult>;
  installRelay?: (check: RelayUpdateCheck, onAttempt: OnAttempt) => Promise<InstallResult>;
  isRunning?: () => boolean;
  stop?: () => unknown;
  start?: () => unknown;
  restartInstalled?: () => { ok: boolean; message: string };
  stopBroker?: () => Promise<'stopped' | 'busy' | 'unavailable'>;
  /** Start the broker's task and wait for the broker to answer. */
  startBroker?: () => Promise<boolean>;
  report?: (line: string) => void;
}

interface UpdateOutcome {
  ok: boolean;
  current: string;
  /** What was installed: herdr-remote, or the relay it depends on alone. */
  updated: 'cli' | 'relay' | null;
  installed?: string | null;
  restarted: boolean;
  /** The Windows admin broker, when it was running. */
  adminBroker?: 'restarted' | 'failed' | 'busy' | null;
  errorKey?: string;
  summary?: string;
}

function restartWithInstalledRelease(): { ok: boolean; message: string } {
  const result = spawnSync(process.execPath, [cliEntryPoint(), 'restart', '--json'], {
    encoding: 'utf8',
    timeout: RESTART_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) return { ok: true, message: '' };
  const output = String(result.stderr || result.stdout || '').trim();
  return { ok: false, message: result.error?.message || output || `exit ${result.status}` };
}

export async function runUpdate(t: Translate, options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const config = () => options.config ?? loadConfig();
  const {
    platform = process.platform,
    checkCli = () => checkForUpdate(),
    checkRelay = () => checkForRelayUpdate(),
    installCli = (check, onAttempt) =>
      performUpdate({
        registry: check.registry,
        sources: check.sources,
        version: check.latest,
        onAttempt,
      }),
    installRelay = (check, onAttempt) =>
      performRelayUpdate({
        registry: check.registry,
        sources: check.sources,
        relayVersion: check.latest ?? '',
        onAttempt,
      }),
    isRunning = () => servicesRunning(config()),
    stop = () => stopAll(config()),
    start = () => startAll(config()),
    restartInstalled = restartWithInstalledRelease,
    stopBroker = stopAdminBroker,
    startBroker = async () => {
      try {
        startAdminBrokerTask(t);
      } catch {
        // Denied or no task: the broker does not answer, which is reported next.
      }
      return waitForAdminBroker();
    },
    report = (line) => process.stdout.write(`${line}\n`),
  } = options;

  report(t('update.checking'));
  const [cli, relay] = await Promise.all([checkCli(), checkRelay()]);
  const { current } = cli;
  if (!cli.ok) {
    report(t('update.errorNetworkDetail', { message: cli.message ?? '' }));
    return { ok: false, current, updated: null, restarted: false, errorKey: cli.errorKey };
  }
  // A new herdr-remote brings the newest relay its range allows; only a
  // current one needs the relay installed by itself.
  const updated = cli.updateAvailable ? 'cli' : relay.ok && relay.updateAvailable ? 'relay' : null;
  if (!updated) {
    report(t('update.upToDate', { version: current }));
    return { ok: true, current, updated, restarted: false };
  }

  const version = (updated === 'cli' ? cli.latest : relay.latest) ?? '';
  const wasRunning = isRunning();
  // Windows refuses to replace files a running process holds, as services
  // started by older releases do. Elsewhere they keep serving until the restart.
  const stopped = platform === 'win32' && wasRunning;
  if (stopped) {
    report(t('update.stoppingServices'));
    stop();
  }
  // The admin broker stops too, so its task starts it on the new release.
  const broker = platform === 'win32' ? await stopBroker() : 'unavailable';
  const restoreBroker = async (): Promise<UpdateOutcome['adminBroker']> => {
    if (broker !== 'stopped') return broker === 'busy' ? 'busy' : null;
    const back = await startBroker();
    report(t(back ? 'update.brokerRestarted' : 'update.brokerRestartFailed'));
    return back ? 'restarted' : 'failed';
  };
  report(t(updated === 'cli' ? 'update.updating' : 'relayUpdate.updating', { version }));
  const onAttempt: OnAttempt = ({ attempt }) => {
    if (attempt > 1) report(t('update.updatingRetry', { version, attempt }));
  };
  const result =
    updated === 'cli' ? await installCli(cli, onAttempt) : await installRelay(relay, onAttempt);

  if (!result.ok) {
    // Nothing was replaced, so the old release starts as it was.
    if (stopped) start();
    const adminBroker = await restoreBroker();
    report(
      t(result.errorKey ?? 'update.errorFailed', { version, installed: result.installed ?? '' }),
    );
    if (result.summary) report(t('update.errorFailedDetail', { message: result.summary }));
    if (platform === 'win32' && /\b(EBUSY|EPERM)\b/.test(result.output ?? '')) {
      report(t('update.errorBusy'));
    }
    const { errorKey, summary } = result;
    return { ok: false, current, updated, restarted: false, adminBroker, errorKey, summary };
  }

  const installed = result.installed ?? version;
  report(t(updated === 'cli' ? 'update.done' : 'relayUpdate.done', { version: installed }));
  let ok = true;
  let restarted = false;
  if (!wasRunning) {
    report(t('update.notRunning'));
  } else {
    report(t('update.restarting'));
    const restart = restartInstalled();
    ok = restart.ok;
    restarted = restart.ok;
    report(
      restart.ok
        ? t('services.restarted')
        : t('update.restartFailed', { message: restart.message }),
    );
  }
  if (broker === 'busy') report(t('update.brokerBusy'));
  const adminBroker = await restoreBroker();
  return { ok, current, updated, installed, restarted, adminBroker };
}
