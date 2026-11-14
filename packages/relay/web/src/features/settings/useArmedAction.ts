import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a button stays armed, waiting for its second press. */
const ARMED_MS = 4_000;

/**
 * A reset with no undo asks to be pressed twice: the first press arms it (the
 * caller swaps the label for the question), the second within a few seconds
 * runs `action`.
 */
export function useArmedAction(action: () => void) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  }, []);

  useEffect(() => disarm, [disarm]);

  const press = () => {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(disarm, ARMED_MS);
      return;
    }
    disarm();
    action();
  };

  return { armed, press, disarm };
}
