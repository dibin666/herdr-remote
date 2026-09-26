// The events a client adapter raises, and the listener registry behind them.

import type {
  ClientRole,
  ServerAgentStatusMessage,
  ServerHostFontChunkMessage,
  ServerHostFontSubsetMessage,
  ServerReadyMessage,
  ServerSessionReadyMessage,
  ServerSessionRestartedMessage,
  ServerUpdateStatusMessage,
} from '@protocol/messages';
import type { HostTerminalFont } from '@protocol/terminal';
import type { ConnectionState } from '../types/connection';

export type AdapterEventMap = {
  /**
   * `code` is the relay's own machine-readable reason, when it gave one.
   *
   * `detail` is the server's English sentence, which is the right thing to show
   * an operator reading logs and the wrong thing to show a Chinese interface.
   * Carrying the code alongside it lets the UI say the same thing in its own
   * language and keep the original only as a fallback.
   */
  stateChange: (state: ConnectionState, detail?: string, code?: string) => void;
  roleChange: (
    role: ClientRole,
    controllerId?: string | null,
    hostId?: string,
    assignedClientId?: string,
  ) => void;
  ready: (payload: ServerReadyMessage) => void;
  paired: (payload: {
    token: string;
    deviceId?: string;
    hostId?: string;
    expiresAt?: number | string;
  }) => void;
  controlState: (role: ClientRole, controllerId?: string | null) => void;
  sessionReady: (payload: ServerSessionReadyMessage) => void;
  exit: (code?: number | null, reason?: string) => void;
  controlGranted: () => void;
  /** How many windows currently share this terminal, this one included. */
  peerCount: (count: number) => void;
  /** The authenticated host socket is temporarily reconnecting. */
  hostReconnecting: (code?: string) => void;
  /** A new PTY was created after a host handoff or profile switch. */
  sessionRestarted: (
    cols?: number,
    rows?: number,
    palette?: ServerSessionRestartedMessage['terminalPalette'],
    hostname?: string,
  ) => void;
  error: (error: { code: string | number; message: string }) => void;
  binaryData: (data: Uint8Array) => void;
  rttUpdate: (rttMs: number) => void;
  pasteFileReady: (path: string) => void;
  /** What the workstation's agents are doing; broadcast, not stream-scoped. */
  agentStatus: (status: ServerAgentStatusMessage) => void;
  /** Whether the workstation's herdr-remote has a newer release; broadcast. */
  updateStatus: (status: ServerUpdateStatusMessage) => void;
  /**
   * The workstation's terminal font: with `ready`, after a session restart,
   * and whenever the host re-reads it. `null` when the host reported none.
   */
  terminalFont: (font: HostTerminalFont | null) => void;
  /** One slice of a font file this window asked for. */
  hostFontChunk: (chunk: ServerHostFontChunkMessage) => void;
  /** A large font cut to the characters this window asked for. */
  hostFontSubset: (subset: ServerHostFontSubsetMessage) => void;
};

export class AdapterEvents {
  private listeners: {
    [K in keyof AdapterEventMap]: Set<AdapterEventMap[K]>;
  } = {
    stateChange: new Set(),
    roleChange: new Set(),
    ready: new Set(),
    paired: new Set(),
    controlState: new Set(),
    sessionReady: new Set(),
    exit: new Set(),
    controlGranted: new Set(),
    peerCount: new Set(),
    hostReconnecting: new Set(),
    sessionRestarted: new Set(),
    error: new Set(),
    binaryData: new Set(),
    rttUpdate: new Set(),
    pasteFileReady: new Set(),
    agentStatus: new Set(),
    updateStatus: new Set(),
    terminalFont: new Set(),
    hostFontChunk: new Set(),
    hostFontSubset: new Set(),
  };

  public on<K extends keyof AdapterEventMap>(event: K, listener: AdapterEventMap[K]): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  protected emit<K extends keyof AdapterEventMap>(
    event: K,
    ...args: Parameters<AdapterEventMap[K]>
  ): void {
    const set = this.listeners[event];
    set.forEach((fn) => {
      try {
        // @ts-expect-error dynamic arg forwarding
        fn(...args);
      } catch (err) {
        console.error(`Error in event listener for ${event}:`, err);
      }
    });
  }
}
