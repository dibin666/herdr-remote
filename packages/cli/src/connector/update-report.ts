// Telling a workstation's windows whether its herdr-remote is behind.

import {
  checkForUpdate,
  compareVersions,
  currentVersion,
  installedVersionOnDisk,
  type UpdateCheck,
  updateChecksEnabled,
} from '../updater.js';

/** Windows opening within this long of a check reuse its answer. */
const UPDATE_RECHECK_MS = 60_000;

export interface UpdateReportOptions {
  /** Asks npm; `null` turns checking off. */
  checkUpdate?: (() => Promise<UpdateCheck>) | null;
  readInstalledVersion?: () => string | null;
  runningVersion?: string;
}

/**
 * Whether a newer herdr-remote is out, asked when a window opens. The version
 * this process runs is fixed at start; the one on disk moves when somebody
 * updates without restarting.
 */
export class UpdateReport {
  private readonly checkUpdate: (() => Promise<UpdateCheck>) | null;
  private readonly readInstalledVersion: () => string | null;
  private readonly runningVersion: string;
  private readonly send: (payload: unknown) => void;
  private checkedAt = 0;
  /** The check in flight, if any. */
  pending: Promise<void> | null = null;

  constructor(options: UpdateReportOptions, send: (payload: unknown) => void) {
    this.checkUpdate =
      options.checkUpdate !== undefined
        ? options.checkUpdate
        : updateChecksEnabled()
          ? checkForUpdate
          : null;
    this.readInstalledVersion = options.readInstalledVersion || installedVersionOnDisk;
    this.runningVersion = options.runningVersion || currentVersion();
    this.send = send;
  }

  /**
   * Tell every window whether this workstation's herdr-remote is behind the
   * newest release. Asked at most once a minute however many windows open;
   * the relay keeps the last answer for windows that open in between. A failed
   * check says nothing: offline is not news.
   */
  report({ now = Date.now() } = {}): Promise<void> | null {
    const checkUpdate = this.checkUpdate;
    if (!checkUpdate || this.pending) return this.pending;
    if (now - this.checkedAt < UPDATE_RECHECK_MS) return null;
    this.checkedAt = now;
    this.pending = Promise.resolve()
      .then(() => checkUpdate())
      .then((result) => {
        if (!result?.ok || !result.latest) return;
        const running = this.runningVersion;
        const installed = this.readInstalledVersion() || running;
        this.send({
          type: 'update_status',
          current: running,
          installed,
          latest: result.latest,
          updateAvailable: compareVersions(result.latest, running) > 0,
          // Updated on disk, still running the old code: a restart finishes it.
          restartPending: compareVersions(installed, running) > 0,
        });
      })
      .catch(() => {
        // Offline, or the registry is down: nothing worth telling a window.
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
