import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import {
  ClientRole,
  ConnectionState,
  ConnectionConfig,
  HostTerminalPalette,
} from '../types/protocol';
import { HerdrClientAdapter } from '../protocol/clientAdapter';
import { isWheelOnlyInput } from '../protocol/scrollInput';
import {
  StoredSettings,
  loadSettings,
  saveSettings,
} from '../utils/storage';
import { translate, Language } from '../i18n';
import { applyDocumentTheme } from '../utils/theme';

export interface ToastItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: number;
  /**
   * How many times this exact notice has fired while it was on screen. A
   * viewer-mode warning is raised per keystroke, so without collapsing repeats
   * a single sentence typed after releasing control buries the terminal.
   */
  count: number;
}

/** How long a notice stays up, counted from its most recent repeat. */
export const TOAST_DISMISS_MS = 4000;
/** Distinct notices on screen at once; the oldest is dropped past this. */
export const MAX_VISIBLE_TOASTS = 3;

/** Ring-buffer bounds for output received while no terminal sink is attached. */
export const MAX_PENDING_OUTPUT_CHUNKS = 4096;
export const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

export type TerminalOutputSink = (data: Uint8Array) => void;

interface TerminalContextValue {
  connectionState: ConnectionState;
  stateDetail?: string;
  role: ClientRole;
  controllerId?: string;
  hostId?: string;
  assignedClientId?: string;
  isController: boolean;
  rttMs: number | null;
  statusPayload: Record<string, unknown> | null;
  /**
   * Timestamp of the most recent successful pairing, or null if this session
   * has not paired. Consumers watch it to leave the pairing UI: the pairing
   * screen must not stay up once the relay has accepted the code.
   */
  lastPairedAt: number | null;
  settings: StoredSettings;
  /** The host terminal's own colors, or null when the host could not report them. */
  hostPalette: HostTerminalPalette | null;
  terminalDimensions: { cols: number; rows: number };
  toasts: ToastItem[];
  adapter: HerdrClientAdapter | null;
  language: Language;

  t: (path: string, params?: Record<string, string | number>) => string;
  setLanguage: (lang: Language) => void;
  connect: (overrideConfig?: Partial<ConnectionConfig>) => void;
  disconnect: () => void;
  claimControl: (force?: boolean) => void;
  releaseControl: () => void;
  sendKey: (rawKey: string) => void;
  sendBinary: (data: Uint8Array | ArrayBuffer) => void;
  sendResize: (cols: number, rows: number) => void;
  updateSettings: (partial: Partial<StoredSettings>) => void;
  addToast: (type: ToastItem['type'], message: string) => void;
  removeToast: (id: string) => void;
  /**
   * Announce that this client cannot type into the session.
   *
   * Read-only is a *mode*, not an event, but every rejected keystroke used to
   * raise its own toast. Held keys and paste bursts turned that into a wall of
   * notifications that kept re-arming its own dismissal timer, so the warning
   * never left the screen while the user was still typing. This says it once
   * per stretch of viewer role; the role badge is the standing reminder.
   */
  warnViewerMode: () => void;

  /**
   * Attach the live xterm instance as the sink for raw PTY output.
   * Anything buffered while no sink was attached is flushed, in arrival order,
   * before the sink starts receiving live chunks. Returns an unsubscribe fn
   * that puts the stream back into buffering mode.
   */
  subscribeToOutput: (sink: TerminalOutputSink) => () => void;
  /** Number of chunks currently buffered (diagnostics / tests). */
  getPendingOutputChunkCount: () => number;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

function buildConnectionConfig(source: StoredSettings): ConnectionConfig {
  return {
    wsUrl: source.wsUrl,
    token: source.token || undefined,
    pairCode: source.pairCode || undefined,
    clientId: source.clientId,
    autoReconnect: source.autoReconnect,
    reconnectIntervalMs: 2000,
    maxReconnectAttempts: 10,
    pingIntervalMs: 10000,
  };
}

export const TerminalProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettingsState] = useState<StoredSettings>(loadSettings);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [stateDetail, setStateDetail] = useState<string | undefined>();
  const [role, setRole] = useState<ClientRole>('viewer');
  const [controllerId, setControllerId] = useState<string | undefined>();
  const [hostId, setHostId] = useState<string | undefined>();
  const [hostPalette, setHostPalette] = useState<HostTerminalPalette | null>(null);
  const [assignedClientId, setAssignedClientId] = useState<string | undefined>();
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [statusPayload, setStatusPayload] = useState<Record<string, unknown> | null>(null);
  const [lastPairedAt, setLastPairedAt] = useState<number | null>(null);
  const [terminalDimensions, setTerminalDimensions] = useState<{ cols: number; rows: number }>({
    cols: 80,
    rows: 24,
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => {
    applyDocumentTheme();
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const adapterRef = useRef<HerdrClientAdapter | null>(null);
  const dimensionsRef = useRef(terminalDimensions);
  dimensionsRef.current = terminalDimensions;

  const t = useCallback(
    (path: string, params?: Record<string, string | number>) => {
      return translate(settings.language, path, params);
    },
    [settings.language]
  );

  const tRef = useRef(t);
  tRef.current = t;

  // Raw ANSI output plumbing. Lives at provider scope so that unmounting or
  // hiding TerminalView never drops a chunk: with no sink attached the stream is
  // buffered in arrival order and replayed on re-attach.
  const outputSinkRef = useRef<TerminalOutputSink | null>(null);
  const pendingOutputRef = useRef<Uint8Array[]>([]);
  const pendingOutputBytesRef = useRef(0);

  const enqueueOutput = useCallback((data: Uint8Array) => {
    pendingOutputRef.current.push(data);
    pendingOutputBytesRef.current += data.byteLength;

    // Bounded ring buffer: drop the oldest chunks rather than growing forever
    // while the page sits on another view.
    while (
      pendingOutputRef.current.length > MAX_PENDING_OUTPUT_CHUNKS ||
      pendingOutputBytesRef.current > MAX_PENDING_OUTPUT_BYTES
    ) {
      const dropped = pendingOutputRef.current.shift();
      if (!dropped) break;
      pendingOutputBytesRef.current -= dropped.byteLength;
    }
  }, []);

  const handleBinaryOutput = useCallback(
    (data: Uint8Array) => {
      const sink = outputSinkRef.current;
      if (sink) {
        try {
          sink(data);
          return;
        } catch (err) {
          console.debug('Terminal output sink threw, buffering chunk instead:', err);
        }
      }
      enqueueOutput(data);
    },
    [enqueueOutput]
  );

  const handleBinaryOutputRef = useRef(handleBinaryOutput);
  handleBinaryOutputRef.current = handleBinaryOutput;

  const subscribeToOutput = useCallback((sink: TerminalOutputSink) => {
    outputSinkRef.current = sink;

    // Replay everything buffered while detached, preserving arrival order. A
    // sink that throws part-way through (terminal not painted yet) must not
    // cost us the rest of the stream, so the unflushed tail goes back on the
    // queue ahead of any live chunk.
    const queued = pendingOutputRef.current;
    pendingOutputRef.current = [];
    pendingOutputBytesRef.current = 0;
    for (let i = 0; i < queued.length; i++) {
      try {
        sink(queued[i]);
      } catch (err) {
        console.debug('Terminal sink threw while flushing, re-buffering the tail:', err);
        for (let j = i; j < queued.length; j++) {
          enqueueOutput(queued[j]);
        }
        break;
      }
    }

    return () => {
      if (outputSinkRef.current === sink) {
        outputSinkRef.current = null;
      }
    };
  }, [enqueueOutput]);

  const getPendingOutputChunkCount = useCallback(() => pendingOutputRef.current.length, []);

  // The live list is held in a ref as well as in state: `addToast` can fire many
  // times between two renders (once per keystroke), and a reducer reading stale
  // state would miss the entry it is supposed to be collapsing into.
  const toastListRef = useRef<ToastItem[]>([]);
  const toastTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const commitToasts = useCallback((next: ToastItem[]) => {
    toastListRef.current = next;
    setToasts(next);
  }, []);

  const dropToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    commitToasts(toastListRef.current.filter((item) => item.id !== id));
  }, [commitToasts]);

  const dropToastRef = useRef(dropToast);
  dropToastRef.current = dropToast;

  const addToast = useCallback((type: ToastItem['type'], message: string) => {
    const now = Date.now();
    const current = toastListRef.current;
    const existing = current.find((item) => item.type === type && item.message === message);
    const id = existing ? existing.id : `${now}-${Math.random().toString(36).substring(2, 6)}`;

    let next: ToastItem[];
    if (existing) {
      next = current.map((item) =>
        item.id === id ? { ...item, count: item.count + 1, timestamp: now } : item
      );
    } else {
      next = [...current, { id, type, message, timestamp: now, count: 1 }];
      // Whatever falls off the end has to give up its dismissal timer too, or
      // it would keep matching as "already on screen" after it is gone.
      while (next.length > MAX_VISIBLE_TOASTS) {
        const [dropped, ...rest] = next;
        const timer = toastTimersRef.current.get(dropped.id);
        if (timer) {
          clearTimeout(timer);
          toastTimersRef.current.delete(dropped.id);
        }
        next = rest;
      }
    }

    commitToasts(next);

    // Each repeat restarts the countdown, so a burst clears once it stops.
    const running = toastTimersRef.current.get(id);
    if (running) clearTimeout(running);
    toastTimersRef.current.set(
      id,
      setTimeout(() => dropToastRef.current(id), TOAST_DISMISS_MS)
    );
  }, [commitToasts]);

  const removeToast = useCallback((id: string) => {
    dropToastRef.current(id);
  }, []);

  // Armed once per stretch of viewer role: the first blocked input warns, the
  // rest of the burst is silent. Taking control re-arms it, so the warning is
  // available again the next time control is lost.
  const viewerWarningArmedRef = useRef(true);

  useEffect(() => {
    if (role === 'controller') viewerWarningArmedRef.current = true;
  }, [role]);

  const warnViewerMode = useCallback(() => {
    if (!viewerWarningArmedRef.current) return;
    viewerWarningArmedRef.current = false;
    addToast('warning', tRef.current('toasts.viewerModeWarning'));
  }, [addToast]);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const updateSettings = useCallback((partial: Partial<StoredSettings>) => {
    const updated = saveSettings(partial);
    setSettingsState(updated);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    updateSettings({ language: lang });
  }, [updateSettings]);

  /**
   * The adapter is constructed and wired during the first render, not from an
   * effect.
   */
  if (!adapterRef.current) {
    const newAdapter = new HerdrClientAdapter(buildConnectionConfig(settings));
    adapterRef.current = newAdapter;

    newAdapter.on('stateChange', (state, detail) => {
      setConnectionState(state);
      setStateDetail(detail);
      if (state === 'connected') {
        addToast('success', tRef.current('toasts.connected'));
      } else if (state === 'error') {
        addToast('error', detail || tRef.current('toasts.connectionError'));
      }
    });

    newAdapter.on('ready', (readyMsg) => {
      setRole(readyMsg.role);
      setControllerId(readyMsg.controllerId);
      setHostId(readyMsg.hostId);
      if (readyMsg.clientId) {
        setAssignedClientId(readyMsg.clientId);
      }
      // The workstation tells us what its terminal looks like; nothing here
      // decides a color, and an absent palette leaves xterm on its defaults.
      setHostPalette(readyMsg.terminalPalette || null);
    });

    newAdapter.on('roleChange', (newRole, newControllerId, newHostId, newAssignedId) => {
      setRole(newRole);
      setControllerId(newControllerId);
      if (newHostId) setHostId(newHostId);
      if (newAssignedId) setAssignedClientId(newAssignedId);
    });

    newAdapter.on('controlGranted', () => {
      setRole('controller');
      addToast('success', tRef.current('toasts.controlGranted'));
    });

    newAdapter.on('controlDenied', (message) => {
      addToast(
        'warning',
        message || tRef.current('toasts.controlDenied')
      );
    });

    newAdapter.on('controlRevoked', (reason) => {
      setRole('viewer');
      addToast('warning', reason || tRef.current('toasts.controlRevoked'));
    });

    newAdapter.on('paired', (payload) => {
      // Persist token, clear pairCode, never log token
      updateSettings({ token: payload.token, pairCode: '' });
      addToast('success', tRef.current('toasts.pairedSuccess'));
      // Signals the UI to leave the pairing screen. A toast alone is not enough
      // feedback: the code is single-use, so a page that still shows the input
      // invites the user to retype a code that can no longer work.
      setLastPairedAt(Date.now());

      // Reconnect with the new token. This has to be atomic: the previous
      // disconnect-then-reconnect-on-a-timer left the pairing socket closing
      // while its replacement was already connecting, and the late close event
      // spawned a second live session (one controller, one viewer, two PTYs).
      newAdapter.reconnectWith({ token: payload.token, pairCode: undefined });
    });

    newAdapter.on('exit', (code, reason) => {
      addToast(
        'info',
        `${tRef.current('toasts.sessionEnded')}${reason ? `: ${reason}` : ''}${code !== undefined ? ` (${code})` : ''}`
      );
    });

    newAdapter.on('status', (payload) => {
      setStatusPayload(payload);
    });

    newAdapter.on('error', (err) => {
      addToast('error', `[${err.code}] ${err.message}`);
    });

    newAdapter.on('rttUpdate', (rtt) => {
      setRttMs(rtt);
    });

    // Single lifetime subscription: survives TerminalView unmount/hide so no
    // PTY output is lost while the user is on another view.
    newAdapter.on('binaryData', (data) => {
      handleBinaryOutputRef.current(data);
    });
  }

  const adapter = adapterRef.current;

  // Keep the live adapter's credentials in step with saved settings.
  useEffect(() => {
    adapterRef.current?.updateConfig(buildConnectionConfig(settings));
  }, [settings]);

  const connect = useCallback((overrideConfig?: Partial<ConnectionConfig>) => {
    if (adapterRef.current) {
      if (overrideConfig) {
        adapterRef.current.updateConfig(overrideConfig);
      }
      adapterRef.current.connect(dimensionsRef.current);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (adapterRef.current) {
      adapterRef.current.disconnect();
    }
  }, []);

  const claimControl = useCallback((force: boolean = false) => {
    if (adapterRef.current) {
      adapterRef.current.claimControl(force);
    }
  }, []);

  const releaseControl = useCallback(() => {
    if (adapterRef.current) {
      adapterRef.current.releaseControl();
      setRole('viewer');
      addToast('info', tRef.current('toasts.controlReleased'));
    }
  }, [addToast]);

  const sendKey = useCallback((rawKey: string) => {
    if (role !== 'controller') {
      warnViewerMode();
      return;
    }
    if (adapterRef.current) {
      adapterRef.current.sendText(rawKey);
    }
  }, [role, warnViewerMode]);

  const sendBinary = useCallback((data: Uint8Array | ArrayBuffer) => {
    // Viewers are read-only for terminal *input*, but scrolling is not input
    // into the shared session: each client drives its own PTY stream, so a
    // wheel report only moves this device's own screen. Letting it through is
    // what makes a viewer able to read back through an agent's output at all,
    // since a full-screen TUI owns its history and has no xterm scrollback.
    if (role !== 'controller' && !isWheelOnlyInput(data)) {
      return;
    }
    if (adapterRef.current) {
      adapterRef.current.sendBinary(data);
    }
  }, [role]);

  const sendResize = useCallback((cols: number, rows: number) => {
    dimensionsRef.current = { cols, rows };
    setTerminalDimensions({ cols, rows });
    if (adapterRef.current) {
      adapterRef.current.sendResize(cols, rows);
    }
  }, []);

  return (
    <TerminalContext.Provider
      value={{
        connectionState,
        stateDetail,
        role,
        controllerId,
        hostId,
        assignedClientId,
        isController: role === 'controller',
        rttMs,
        statusPayload,
        lastPairedAt,
        settings,
        hostPalette,
        terminalDimensions,
        toasts,
        adapter,
        language: settings.language,
        t,
        setLanguage,
        connect,
        disconnect,
        claimControl,
        releaseControl,
        sendKey,
        sendBinary,
        sendResize,
        updateSettings,
        addToast,
        removeToast,
        warnViewerMode,
        subscribeToOutput,
        getPendingOutputChunkCount,
      }}
    >
      {children}
    </TerminalContext.Provider>
  );
};

export function useTerminal(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error('useTerminal must be used within a TerminalProvider');
  }
  return context;
}
