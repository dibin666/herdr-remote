// Everything this window sends into the terminal: keys, the modifier latch,
// raw input, its size and pasted files. Only a window with input may type; a
// viewer is told so once per stretch of viewer role.

import type { ClientRole } from '@protocol/messages';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Translate } from '../i18n';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import { encodeStringToBytes, type KeyModifiers } from '../protocol/keyEncoder';
import { isWheelOnlyInput } from '../protocol/scrollInput';
import type { ToastItem } from './useToastQueue';

export interface ModifierLatch {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NO_MODIFIERS: ModifierLatch = { ctrl: false, alt: false, shift: false };

export function useTerminalInput({
  adapterRef,
  role,
  addToast,
  tRef,
}: {
  adapterRef: RefObject<HerdrClientAdapter | null>;
  role: ClientRole;
  addToast: (type: ToastItem['type'], message: string) => void;
  tRef: RefObject<Translate>;
}) {
  const [terminalDimensions, setTerminalDimensions] = useState<{ cols: number; rows: number }>({
    cols: 80,
    rows: 24,
  });
  const dimensionsRef = useRef(terminalDimensions);
  dimensionsRef.current = terminalDimensions;
  const pasteFileReadyListenersRef = useRef<Set<(path: string) => void>>(new Set());
  const keyInputObserversRef = useRef<Set<(bytes: Uint8Array) => void>>(new Set());

  // Armed once per stretch of viewer role: the first blocked input warns, the
  // rest of the burst is silent. Taking control re-arms it, so the warning is
  // available again the next time control is lost.
  const viewerWarningArmedRef = useRef(true);

  useEffect(() => {
    if (role === 'controller') viewerWarningArmedRef.current = true;
  }, [role]);

  /**
   * Announce that this client cannot type into the session.
   *
   * Read-only is a *mode*, not an event, but every rejected keystroke used to
   * raise its own toast. Held keys and paste bursts turned that into a wall of
   * notifications that kept re-arming its own dismissal timer, so the warning
   * never left the screen while the user was still typing. This says it once
   * per stretch of viewer role; the role badge is the standing reminder.
   */
  const warnViewerMode = useCallback(() => {
    if (!viewerWarningArmedRef.current) return;
    viewerWarningArmedRef.current = false;
    addToast('warning', tRef.current('toasts.viewerModeWarning'));
  }, [addToast, tRef]);

  const sendKey = useCallback(
    (rawKey: string) => {
      if (role !== 'controller') {
        warnViewerMode();
        return;
      }
      const adapter = adapterRef.current;
      if (!adapter) return;
      const bytes = encodeStringToBytes(rawKey);
      for (const observer of keyInputObserversRef.current) {
        try {
          observer(bytes);
        } catch (err) {
          console.debug('Key input observer threw:', err);
        }
      }
      adapter.sendInput(bytes);
    },
    [adapterRef, role, warnViewerMode],
  );

  /**
   * Sees every key the on-screen toolbars send, before it goes out. The
   * terminal's own keyboard input reaches predictive echo through xterm; keys
   * from the toolbars do not, and an Esc or Enter the predictor never saw left
   * stale predictions on screen.
   */
  const observeKeyInput = useCallback((observer: (bytes: Uint8Array) => void) => {
    keyInputObserversRef.current.add(observer);
    return () => {
      keyInputObserversRef.current.delete(observer);
    };
  }, []);

  /**
   * Ctrl, Alt and Shift latched on the key bar. The latch belongs to the
   * session rather than the bar so that the next key typed on the phone's own
   * keyboard picks it up too: latch Ctrl, type `c`, and that is Ctrl+C.
   */
  const [modifierLatch, setModifierLatch] = useState<ModifierLatch>(NO_MODIFIERS);
  // Read synchronously by the terminal's input handler, which is bound once.
  const modifierLatchRef = useRef<ModifierLatch>(NO_MODIFIERS);
  const toggleModifierLatch = useCallback((modifier: keyof ModifierLatch) => {
    const next = { ...modifierLatchRef.current, [modifier]: !modifierLatchRef.current[modifier] };
    modifierLatchRef.current = next;
    setModifierLatch(next);
  }, []);
  /** Takes the latched modifiers for the key being sent, and releases them. */
  const consumeModifierLatch = useCallback((): KeyModifiers | null => {
    const latch = modifierLatchRef.current;
    if (!latch.ctrl && !latch.alt && !latch.shift) return null;
    modifierLatchRef.current = NO_MODIFIERS;
    setModifierLatch(NO_MODIFIERS);
    return latch;
  }, []);

  const sendBinary = useCallback(
    (data: Uint8Array | ArrayBuffer) => {
      // Viewers are read-only for terminal *input*, but scrolling is not input
      // into the shared session: each client drives its own PTY stream, so a
      // wheel report only moves this device's own screen. Letting it through is
      // what makes a viewer able to read back through an agent's output at all,
      // since a full-screen TUI owns its history and has no xterm scrollback.
      if (role !== 'controller' && !isWheelOnlyInput(data)) {
        return;
      }
      adapterRef.current?.sendInput(data);
    },
    [adapterRef, role],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      dimensionsRef.current = { cols, rows };
      setTerminalDimensions({ cols, rows });
      adapterRef.current?.sendResize(cols, rows);
    },
    [adapterRef],
  );

  const sendPasteFile = useCallback(
    (mime: string, dataBase64: string) => {
      if (role !== 'controller') {
        warnViewerMode();
        return false;
      }
      if (adapterRef.current) {
        adapterRef.current.sendPasteFile(mime, dataBase64);
        return true;
      }
      return false;
    },
    [adapterRef, role, warnViewerMode],
  );

  const subscribeToPasteFileReady = useCallback((handler: (path: string) => void) => {
    pasteFileReadyListenersRef.current.add(handler);
    return () => {
      pasteFileReadyListenersRef.current.delete(handler);
    };
  }, []);

  /** The host saved a pasted file; tell whoever is waiting for its path. */
  const notifyPasteFileReady = useCallback((path: string) => {
    for (const listener of pasteFileReadyListenersRef.current) {
      try {
        listener(path);
      } catch (err) {
        console.error('Error in pasteFileReady listener:', err);
      }
    }
  }, []);

  return {
    terminalDimensions,
    dimensionsRef,
    warnViewerMode,
    sendKey,
    observeKeyInput,
    modifierLatch,
    toggleModifierLatch,
    consumeModifierLatch,
    sendBinary,
    sendResize,
    sendPasteFile,
    subscribeToPasteFileReady,
    notifyPasteFileReady,
  };
}
