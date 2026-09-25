// The session this window has with its relay, published as five contexts so a
// component re-renders only when what it reads changes: settings (with
// translations and fonts), the connection, toasts, terminal input and output,
// and image uploads. `useTerminal()` returns all five together.

import type React from 'react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { isServerErrorCode, type Language, type Translate, translate } from '../i18n';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import type { ConnectionConfig } from '../types/connection';
import { resolveProfile } from '../utils/agentKeymaps';
import { clampFontSize } from '../utils/terminalLayout';
import { applyDocumentTheme, resolveTerminalFontFamily } from '../utils/theme';
import { useHostFont } from '../utils/useHostFont';
import { installWakeListeners } from '../utils/wakeListeners';
import { buildConnectionConfig } from './connectionConfig';
import { INITIAL_SESSION, sessionReducer } from './session';
import { useHerdrLaunch } from './useHerdrLaunch';
import { useHerdrAdapter } from './useHerdrAdapter';
import { useImageUpload } from './useImageUpload';
import { useOutputBuffer } from './useOutputBuffer';
import { useProfiles } from './useProfiles';
import { useTerminalInput } from './useTerminalInput';
import { useToastQueue } from './useToastQueue';
import { useUpdateNotices } from './useUpdateNotices';
import type {
  ConnectionContextValue,
  SettingsContextValue,
  TerminalContextValue,
  TerminalIOContextValue,
  ToastContextValue,
  UploadContextValue,
} from './values';

export type { HerdrLaunchState } from './useHerdrLaunch';
export {
  MAX_PENDING_OUTPUT_BYTES,
  MAX_PENDING_OUTPUT_CHUNKS,
  type TerminalOutputSink,
} from './useOutputBuffer';
export type { ModifierLatch } from './useTerminalInput';
export { MAX_VISIBLE_TOASTS, TOAST_DISMISS_MS, type ToastItem } from './useToastQueue';

const SettingsContext = createContext<SettingsContextValue | null>(null);
const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const ToastContext = createContext<ToastContextValue | null>(null);
const TerminalIOContext = createContext<TerminalIOContextValue | null>(null);
const UploadContext = createContext<UploadContextValue | null>(null);

export const TerminalProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION);
  const adapterRef = useRef<HerdrClientAdapter | null>(null);
  const hasEstablishedConnectionRef = useRef(false);

  useEffect(() => {
    applyDocumentTheme();
  }, []);

  const { receiveOutput, subscribeToOutput, getPendingOutputChunkCount, clearPendingOutput } =
    useOutputBuffer();
  const { toasts, addToast, removeToast } = useToastQueue();

  const resetConnectionPresentation = useCallback(() => {
    clearPendingOutput();
    dispatch({ type: 'reset', resetTerminal: true });
  }, [clearPendingOutput]);

  const {
    settings,
    updateSettings,
    addProfileAndConnect,
    switchProfile,
    renameProfile,
    removeProfile,
    savePairedProfile,
    noteReadyProfile,
  } = useProfiles((next) => {
    resetConnectionPresentation();
    adapterRef.current?.reconnectWith(buildConnectionConfig(next));
  });

  const t = useCallback<Translate>(
    (key, params) => translate(settings.language, key, params),
    [settings.language],
  );
  const tRef = useRef(t);
  tRef.current = t;

  const { herdrLaunch, startHerdr, handleLaunchError, forgetHerdrLaunch } = useHerdrLaunch(
    adapterRef,
    tRef,
  );
  const { updateStatus, ignoredUpdate, ignoreUpdate, receiveUpdateStatus, forgetUpdateStatus } =
    useUpdateNotices(addToast, tRef);
  const input = useTerminalInput({ adapterRef, role: session.role, addToast, tRef });
  const { uploadProgress, uploadImage, resetUploadProgress, abortUpload, completeUpload } =
    useImageUpload({
      adapterRef,
      role: session.role,
      connectionState: session.connectionState,
      warnViewerMode: input.warnViewerMode,
      addToast,
      t,
      sendPasteFile: input.sendPasteFile,
    });

  const adapter = useHerdrAdapter(adapterRef, () => buildConnectionConfig(settings), {
    stateChange: (state, detail, code) => {
      // The relay speaks English to its logs. Where it named a reason, this
      // interface says the same thing in its own language and keeps the
      // server's sentence only for reasons it has never heard of.
      const described = isServerErrorCode(code) ? t(`serverErrors.${code}`) : detail;
      dispatch({ type: 'stateChange', state, detail: described, code });
      if (state === 'connected') {
        addToast('success', t('toasts.connected'));
      } else if (state === 'error') {
        addToast('error', described || t('toasts.connectionError'));
      }
      if (state !== 'connected') forgetHerdrLaunch();
    },
    ready: (message) => {
      // A relay restart cannot preserve the old PTY. Reset before accepting
      // the new stream so output from the previous profile/session is never
      // painted into this connection.
      const resetTerminal = hasEstablishedConnectionRef.current;
      if (resetTerminal) clearPendingOutput();
      hasEstablishedConnectionRef.current = true;
      forgetHerdrLaunch();
      // Another workstation may be on another release; the relay replays this
      // one's answer right after `ready`.
      forgetUpdateStatus();
      dispatch({ type: 'ready', message, resetTerminal });
      noteReadyProfile(message);
    },
    hostReconnecting: (code) => {
      dispatch({
        type: 'hostReconnecting',
        code: code || 'host_reconnecting',
        detail: t(`serverErrors.${isServerErrorCode(code) ? code : 'host_reconnecting'}`),
      });
      clearPendingOutput();
    },
    sessionRestarted: (_cols, _rows, palette, hostname) => {
      clearPendingOutput();
      dispatch({ type: 'sessionRestarted', hostname, palette });
      noteReadyProfile({ hostId: adapterRef.current?.getHostId(), hostname });
    },
    roleChange: (role, controllerId, hostId, assignedClientId) => {
      dispatch({ type: 'roleChange', role, controllerId, hostId, assignedClientId });
    },
    controlGranted: () => {
      dispatch({ type: 'controlGranted' });
      addToast('success', t('toasts.controlGranted'));
    },
    paired: (payload) => {
      // Persist the token in the profile that initiated pairing, never in a
      // global singleton that would overwrite another Herdr connection.
      const next = savePairedProfile(payload);
      addToast('success', t('toasts.pairedSuccess'));
      // Signals the UI to leave the pairing screen. A toast alone is not enough
      // feedback: the code is single-use, so a page that still shows the input
      // invites the user to retype a code that can no longer work.
      dispatch({ type: 'paired', at: Date.now() });
      // Reconnect with the new token. This has to be atomic: the previous
      // disconnect-then-reconnect-on-a-timer left the pairing socket closing
      // while its replacement was already connecting, and the late close event
      // spawned a second live session (one controller, one viewer, two PTYs).
      adapterRef.current?.reconnectWith(buildConnectionConfig(next));
    },
    exit: (code, reason) => {
      addToast(
        'info',
        `${t('toasts.sessionEnded')}${reason ? `: ${reason}` : ''}${code != null ? ` (${code})` : ''}`,
      );
    },
    error: (err) => {
      if (handleLaunchError(err)) return;
      // Belongs to a font transfer, which reports it in its own dialog.
      if (err.code === 'host_font_unavailable') return;
      abortUpload();
      const message = isServerErrorCode(err.code)
        ? t(`serverErrors.${err.code}`)
        : err.message || `[${err.code}]`;
      addToast('error', message);
    },
    pasteFileReady: (path) => {
      completeUpload();
      input.notifyPasteFileReady(path);
    },
    rttUpdate: (rttMs) => dispatch({ type: 'rtt', rttMs }),
    peerCount: (count) => dispatch({ type: 'peerCount', count }),
    sessionReady: () => {
      dispatch({ type: 'sessionReady' });
      forgetHerdrLaunch();
    },
    // Deliberately state and not a toast: this changes whenever an agent picks
    // up or finishes work, and a notification per change would be the flood the
    // status bar exists to replace.
    agentStatus: (status) => dispatch({ type: 'agentStatus', status }),
    updateStatus: receiveUpdateStatus,
    // Single lifetime subscription: survives TerminalView unmount/hide so no
    // PTY output is lost while the user is on another view.
    binaryData: receiveOutput,
  });

  const activeProfile = settings.profiles.find(
    (profile) => profile.id === settings.activeProfileId,
  );

  const { hostFont, loadHostFont, declineHostFont, syncHostFont, ensureHostGlyphs } =
    useHostFont(adapter);
  const requestHostFont = useCallback(() => {
    void loadHostFont();
  }, [loadHostFont]);
  const terminalFontFamily = resolveTerminalFontFamily(
    settings.fontFamily,
    hostFont.font
      ? {
          family: hostFont.font.family,
          alias: hostFont.status === 'loaded' ? hostFont.alias : null,
          glyphs: hostFont.glyphs.source
            ? {
                family: hostFont.glyphs.source.family,
                scope: hostFont.glyphs.source.scope,
                alias: hostFont.glyphs.alias,
              }
            : null,
        }
      : null,
  );
  const terminalFontSize =
    settings.fontSizeFollowsHost && hostFont.font?.sizePx
      ? clampFontSize(hostFont.font.sizePx, settings.fontSize)
      : settings.fontSize;

  // The interface around the terminal is drawn as terminal cells too; it uses
  // the terminal's face so the two read as one screen. Sizes stay fixed.
  useEffect(() => {
    document.documentElement.style.setProperty('--tui-font', terminalFontFamily);
  }, [terminalFontFamily]);

  // Keep the live adapter's credentials in step with saved settings.
  useEffect(() => {
    adapterRef.current?.updateConfig(buildConnectionConfig(settings));
  }, [settings]);

  // Reconnect the moment the page comes back, rather than when the backoff
  // next allows: see wakeListeners.ts.
  useEffect(() => {
    const current = adapterRef.current;
    return current ? installWakeListeners(current) : undefined;
  }, []);

  const { dimensionsRef } = input;
  const connect = useCallback(
    (overrideConfig?: Partial<ConnectionConfig>) => {
      if (!adapterRef.current) return;
      if (overrideConfig) adapterRef.current.updateConfig(overrideConfig);
      adapterRef.current.connect(dimensionsRef.current);
    },
    [dimensionsRef],
  );

  const disconnect = useCallback(() => {
    adapterRef.current?.disconnect();
  }, []);

  const claimControl = useCallback((force: boolean = false) => {
    adapterRef.current?.claimControl(force);
  }, []);

  /**
   * Kept for clients and tests built against the lease, and deliberately inert.
   *
   * Input is not a lease any more: every paired window may type, and demoting
   * this one locally would have the UI refuse keystrokes the relay would have
   * accepted. The message is still sent, because a relay may still be listening
   * for it, and the role is left to whatever the relay says it is.
   */
  const releaseControl = useCallback(() => {
    adapterRef.current?.releaseControl();
  }, []);

  const setLanguage = useCallback(
    (language: Language) => updateSettings({ language }),
    [updateSettings],
  );

  const agentProfile = resolveProfile(session.agentStatus?.focusedAgent, 'auto');

  const settingsValue = useMemo<SettingsContextValue>(
    () => ({
      settings,
      updateSettings,
      language: settings.language,
      setLanguage,
      t,
      profiles: settings.profiles,
      activeProfileId: settings.activeProfileId,
      activeProfile,
      switchProfile,
      addProfileAndConnect,
      renameProfile,
      removeProfile,
      hostFont,
      loadHostFont: requestHostFont,
      declineHostFont,
      syncHostFont,
      ensureHostGlyphs,
      terminalFontFamily,
      terminalFontSize,
    }),
    [
      settings,
      updateSettings,
      setLanguage,
      t,
      activeProfile,
      switchProfile,
      addProfileAndConnect,
      renameProfile,
      removeProfile,
      hostFont,
      requestHostFont,
      declineHostFont,
      syncHostFont,
      ensureHostGlyphs,
      terminalFontFamily,
      terminalFontSize,
    ],
  );

  const connectionValue = useMemo<ConnectionContextValue>(
    () => ({
      ...session,
      isController: session.role === 'controller',
      agentProfile,
      adapter,
      connect,
      disconnect,
      claimControl,
      releaseControl,
      herdrLaunch,
      startHerdr,
      updateStatus,
      ignoredUpdate,
      ignoreUpdate,
    }),
    [
      session,
      agentProfile,
      adapter,
      connect,
      disconnect,
      claimControl,
      releaseControl,
      herdrLaunch,
      startHerdr,
      updateStatus,
      ignoredUpdate,
      ignoreUpdate,
    ],
  );

  const toastValue = useMemo<ToastContextValue>(
    () => ({ toasts, addToast, removeToast }),
    [toasts, addToast, removeToast],
  );

  const {
    terminalDimensions,
    sendKey,
    observeKeyInput,
    modifierLatch,
    toggleModifierLatch,
    consumeModifierLatch,
    sendBinary,
    sendResize,
    warnViewerMode,
    sendPasteFile,
    subscribeToPasteFileReady,
  } = input;
  const ioValue = useMemo<TerminalIOContextValue>(
    () => ({
      terminalDimensions,
      sendKey,
      observeKeyInput,
      modifierLatch,
      toggleModifierLatch,
      consumeModifierLatch,
      sendBinary,
      sendResize,
      warnViewerMode,
      sendPasteFile,
      subscribeToPasteFileReady,
      subscribeToOutput,
      getPendingOutputChunkCount,
    }),
    [
      terminalDimensions,
      sendKey,
      observeKeyInput,
      modifierLatch,
      toggleModifierLatch,
      consumeModifierLatch,
      sendBinary,
      sendResize,
      warnViewerMode,
      sendPasteFile,
      subscribeToPasteFileReady,
      subscribeToOutput,
      getPendingOutputChunkCount,
    ],
  );

  const uploadValue = useMemo<UploadContextValue>(
    () => ({ uploadProgress, uploadImage, resetUploadProgress }),
    [uploadProgress, uploadImage, resetUploadProgress],
  );

  return (
    <SettingsContext.Provider value={settingsValue}>
      <ConnectionContext.Provider value={connectionValue}>
        <ToastContext.Provider value={toastValue}>
          <TerminalIOContext.Provider value={ioValue}>
            <UploadContext.Provider value={uploadValue}>{children}</UploadContext.Provider>
          </TerminalIOContext.Provider>
        </ToastContext.Provider>
      </ConnectionContext.Provider>
    </SettingsContext.Provider>
  );
};

function useRequired<T>(context: React.Context<T | null>, hook: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${hook} must be used within a TerminalProvider`);
  }
  return value;
}

/** Settings, translations, connection profiles and the terminal font. */
export const useSettings = () => useRequired(SettingsContext, 'useSettings');
/** The relay session: its state, the host, and controlling the connection. */
export const useConnection = () => useRequired(ConnectionContext, 'useConnection');
export const useToasts = () => useRequired(ToastContext, 'useToasts');
/** Sending into the terminal, and receiving its output. */
export const useTerminalIO = () => useRequired(TerminalIOContext, 'useTerminalIO');
export const useUpload = () => useRequired(UploadContext, 'useUpload');

/**
 * Everything at once. Prefer the narrower hooks above: a component using this
 * re-renders on every change to any of them.
 */
export function useTerminal(): TerminalContextValue {
  return {
    ...useSettings(),
    ...useConnection(),
    ...useToasts(),
    ...useTerminalIO(),
    ...useUpload(),
  };
}
