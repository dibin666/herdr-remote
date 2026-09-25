// Herdr not running on the paired workstation, and starting it from here.

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Translate } from '../i18n';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';

/**
 * Herdr is not running on the paired workstation. `null` while it is, or while
 * nothing has said otherwise.
 */
export type HerdrLaunchState =
  | { phase: 'stopped' }
  | { phase: 'starting' }
  | { phase: 'failed'; message: string };

/** How long a start may take before the window stops waiting for an answer. */
const HERDR_START_TIMEOUT_MS = 30_000;

export function useHerdrLaunch(
  adapterRef: RefObject<HerdrClientAdapter | null>,
  tRef: RefObject<Translate>,
) {
  const [herdrLaunch, setHerdrLaunchState] = useState<HerdrLaunchState | null>(null);
  // The adapter's handlers are bound once, so they read the phase from here.
  const herdrLaunchRef = useRef<HerdrLaunchState | null>(null);
  const herdrStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setHerdrLaunch = useCallback((next: HerdrLaunchState | null) => {
    if (next?.phase !== 'starting' && herdrStartTimerRef.current) {
      clearTimeout(herdrStartTimerRef.current);
      herdrStartTimerRef.current = null;
    }
    herdrLaunchRef.current = next;
    setHerdrLaunchState(next);
  }, []);

  /** Ask the paired workstation to start its Herdr. */
  const startHerdr = useCallback(() => {
    const current = adapterRef.current;
    if (!current) return;
    setHerdrLaunch({ phase: 'starting' });
    current.sendHerdrStart();
    // A host connector from before this message ignores it; say so rather
    // than spin forever.
    herdrStartTimerRef.current = setTimeout(() => {
      herdrStartTimerRef.current = null;
      if (herdrLaunchRef.current?.phase === 'starting') {
        setHerdrLaunch({ phase: 'failed', message: tRef.current('herdrLaunch.timeout') });
      }
    }, HERDR_START_TIMEOUT_MS);
  }, [adapterRef, tRef, setHerdrLaunch]);

  /**
   * A relay error that belongs to the launch: not an error to toast but a
   * question for the user, asked over the empty terminal until Herdr runs.
   * Returns whether it was one.
   */
  const handleLaunchError = useCallback(
    (error: { code: string | number; message: string }) => {
      if (error.code === 'herdr_not_running') {
        if (herdrLaunchRef.current?.phase !== 'starting') setHerdrLaunch({ phase: 'stopped' });
        return true;
      }
      if (error.code === 'herdr_start_failed' && herdrLaunchRef.current) {
        setHerdrLaunch({ phase: 'failed', message: error.message || '' });
        return true;
      }
      return false;
    },
    [setHerdrLaunch],
  );

  /** Whether Herdr runs is the answer of one connection; the next one asks again. */
  const forgetHerdrLaunch = useCallback(() => setHerdrLaunch(null), [setHerdrLaunch]);

  useEffect(
    () => () => {
      if (herdrStartTimerRef.current) clearTimeout(herdrStartTimerRef.current);
    },
    [],
  );

  return { herdrLaunch, startHerdr, handleLaunchError, forgetHerdrLaunch };
}
