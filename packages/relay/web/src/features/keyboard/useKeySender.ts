// Sending keys from the bar: a tap buzzes, a viewer is told it cannot type,
// and a latched modifier applies to the next key.

import { useCallback, useEffect, useRef } from 'react';
import { useConnection, useSettings, useTerminalIO } from '@/context/TerminalContext';
import { parseKeyCombo } from '@/shared/keys/keyCombo';
import { encodeKeyWithModifiers } from '@/shared/keys/keyEncoder';

export function useKeySender() {
  const { settings } = useSettings();
  const { isController } = useConnection();
  const { sendKey, warnViewerMode, consumeModifierLatch } = useTerminalIO();
  const comboTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of comboTimersRef.current) clearTimeout(timer);
      comboTimersRef.current = [];
    },
    [],
  );

  const vibrate = useCallback(() => {
    if (settings.vibrateOnKeyPress && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch {
        // Ignore vibration errors
      }
    }
  }, [settings.vibrateOnKeyPress]);

  /**
   * Sends one key, with whatever modifiers are latched. A latch applies to the
   * next key of any kind — Ctrl+←, Shift+Enter, Shift+F5 — and a ready-made
   * chord such as ^C just releases it, since the chord already says what it is.
   */
  const pressKey = useCallback(
    (keySeq: string, modifiable = true) => {
      vibrate();

      if (!isController) {
        warnViewerMode();
        return;
      }

      const modifiers = consumeModifierLatch();
      sendKey(modifiable && modifiers ? encodeKeyWithModifiers(keySeq, modifiers) : keySeq);
    },
    [isController, sendKey, warnViewerMode, vibrate, consumeModifierLatch],
  );

  /** Sends an agent shortcut such as `esc esc` or `ctrl+t`. */
  const sendCombo = useCallback(
    (combo: string) => {
      vibrate();
      if (!isController) {
        warnViewerMode();
        return;
      }

      let steps: string[];
      try {
        steps = parseKeyCombo(combo);
      } catch {
        return;
      }
      // A ready-made shortcut consumes a pending modifier the same way a Ctrl
      // chord does; its own declared modifiers are already part of the combo.
      consumeModifierLatch();
      if (steps.length === 1) {
        sendKey(steps[0]);
        return;
      }

      // The adapter merges writes queued in one microtask. Spacing sequence steps
      // keeps Esc Esc as two keypresses so rewind menus still receive both.
      steps.forEach((step, index) => {
        const timer = setTimeout(() => {
          comboTimersRef.current = comboTimersRef.current.filter((item) => item !== timer);
          sendKey(step);
        }, index * 120);
        comboTimersRef.current.push(timer);
      });
    },
    [consumeModifierLatch, isController, sendKey, vibrate, warnViewerMode],
  );

  return { vibrate, pressKey, sendCombo };
}
