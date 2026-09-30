// Watching what the agents on this workstation are doing, for the status bar
// of every window attached to it.

import {
  type AgentSummary,
  type HerdrSessionSnapshot,
  sameSummary,
  summarizeAgents,
} from '../agent-status.js';
import {
  type HerdrEvent,
  type HerdrSubscription,
  requestHerdr,
  subscribeHerdr,
} from '../herdr-api.js';

/** How often the agent summary is re-read while a browser is watching. */
const AGENT_STATUS_POLL_MS = 5_000;
const AGENT_STATUS_EVENT_DEBOUNCE_MS = 150;
const AGENT_STATUS_SUBSCRIPTIONS = [
  { type: 'pane.focused' },
  { type: 'tab.focused' },
  { type: 'workspace.focused' },
  { type: 'pane.agent_detected' },
];

export interface AgentWatchOptions {
  socketPath: string;
  requestHerdr?: typeof requestHerdr;
  subscribeHerdr?: (
    socketPath: string,
    subscriptions: { type: string }[],
    onEvent: (event: HerdrEvent) => void,
    options: { onStarted?: () => void },
  ) => HerdrSubscription;
}

/**
 * A side channel, on its own socket, alive only while a browser is attached.
 * Herdr's server can be restarted underneath a running herdr-remote — the
 * PTYs survive it — so every failure here is a retry, never anything a
 * terminal session notices.
 *
 * A long-lived subscription provides fast refreshes on pane and workspace
 * focus changes; the five-second poll still repairs missed events and a
 * restarted Herdr server. Both paths only read the side-channel snapshot, and
 * events only invalidate it: Herdr's snapshots and events share no sequence,
 * so each (re)started subscription and each event mid-read asks for a fresh
 * read rather than patching the last one.
 */
export class AgentWatch {
  private readonly socketPath: string;
  private readonly request: typeof requestHerdr;
  private readonly subscribe: NonNullable<AgentWatchOptions['subscribeHerdr']>;
  private readonly send: (payload: unknown) => void;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private subscription: HerdrSubscription | null = null;
  private pending = false;
  private stale = false;
  private lastSummary: AgentSummary | null = null;

  constructor(options: AgentWatchOptions, send: (payload: unknown) => void) {
    this.socketPath = options.socketPath;
    this.request = options.requestHerdr || requestHerdr;
    this.subscribe = options.subscribeHerdr || subscribeHerdr;
    this.send = send;
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.read(), AGENT_STATUS_POLL_MS);
    this.pollTimer.unref?.();
    try {
      this.subscription = this.subscribe(
        this.socketPath,
        AGENT_STATUS_SUBSCRIPTIONS,
        () => this.scheduleRead(),
        { onStarted: () => this.scheduleRead() },
      );
    } catch {
      // A missing or restarting Herdr server leaves the regular poll in place.
    }
    this.read();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.subscription) {
      this.subscription.close();
      this.subscription = null;
    }
    this.stale = false;
    this.lastSummary = null;
  }

  private scheduleRead(): void {
    if (!this.pollTimer) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.read();
    }, AGENT_STATUS_EVENT_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * Read the summary and forward it if it changed.
   *
   * A slow answer must not stack up behind the next tick, and a failed one
   * leaves the last summary standing rather than blanking the browser's chip:
   * Herdr's server not running is an ordinary state, not news.
   */
  private async read(): Promise<void> {
    if (!this.pollTimer) return;
    if (this.pending) {
      this.stale = true;
      return;
    }
    this.pending = true;
    this.stale = false;
    let snapshot: HerdrSessionSnapshot | null | undefined;
    try {
      const result = await this.request<{ snapshot?: HerdrSessionSnapshot } | null>(
        this.socketPath,
        'session.snapshot',
        {},
      );
      snapshot = result?.snapshot || (result as HerdrSessionSnapshot | null);
    } catch {
      return;
    } finally {
      this.pending = false;
      // Something changed while this answer was in flight; it may predate it.
      if (this.stale) this.scheduleRead();
    }
    // Stopped while the answer was in flight; the browser it was for is gone.
    if (!this.pollTimer) return;
    const summary = summarizeAgents(snapshot);
    if (sameSummary(this.lastSummary, summary)) return;
    this.lastSummary = summary;
    this.send({ type: 'agent_status', ...summary });
  }
}
