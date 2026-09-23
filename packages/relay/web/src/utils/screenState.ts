/**
 * Follows two private modes that Herdr drives on every frame and that xterm
 * 5.5 does not surface:
 *
 * - DECTCEM (`?25`), cursor visibility. xterm tracks it, but only on a private
 *   service. Herdr hides the cursor while an agent that paints its own caret
 *   is focused, and while its own overlays are open.
 * - Synchronized output (`?2026`). Herdr fences each frame with it; xterm 5.5
 *   ignores it and renders, and reports parsed writes, halfway through a
 *   frame. Anything that inspects the screen mid-frame sees a half-drawn one.
 *
 * The handlers only observe: each returns `false`, so xterm's own handling of
 * the same sequences still runs.
 */

type CsiParams = ReadonlyArray<number | number[]>;

interface Disposable {
  dispose(): void;
}

export interface ScreenStateParser {
  registerCsiHandler(
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: CsiParams) => boolean | Promise<boolean>,
  ): Disposable;
  registerEscHandler(
    id: { intermediates?: string; final: string },
    callback: () => boolean | Promise<boolean>,
  ): Disposable;
}

export interface ScreenState {
  isCursorHidden(): boolean;
  /** True between `?2026h` and `?2026l`, for at most a second. */
  isSynchronizing(): boolean;
  reset(): void;
  dispose(): void;
}

const CURSOR_VISIBLE = 25;
const SYNCHRONIZED_OUTPUT = 2026;
/**
 * A frame whose closing `?2026l` was lost (a dropped connection mid-frame)
 * must not freeze everything that waits for frames to finish. Herdr's frames
 * take milliseconds; a second is far past any real one.
 */
const SYNC_TIMEOUT_MS = 1000;

export function attachScreenState(
  term: { parser?: ScreenStateParser },
  now: () => number = () => performance.now(),
): ScreenState {
  let cursorHidden = false;
  let syncStartedAt: number | null = null;

  const reset = () => {
    cursorHidden = false;
    syncStartedAt = null;
  };

  const parser = term.parser;
  if (!parser || typeof parser.registerCsiHandler !== 'function') {
    return {
      isCursorHidden: () => false,
      isSynchronizing: () => false,
      reset,
      dispose: () => {},
    };
  }

  const onPrivateMode = (set: boolean) => (params: CsiParams) => {
    for (const param of params.flat()) {
      if (param === CURSOR_VISIBLE) cursorHidden = !set;
      if (param === SYNCHRONIZED_OUTPUT) syncStartedAt = set ? now() : null;
    }
    return false;
  };

  const disposables: Disposable[] = [
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, onPrivateMode(true)),
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, onPrivateMode(false)),
    // Soft and full resets show the cursor again and end any frame.
    parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      reset();
      return false;
    }),
  ];
  if (typeof parser.registerEscHandler === 'function') {
    disposables.push(
      parser.registerEscHandler({ final: 'c' }, () => {
        reset();
        return false;
      }),
    );
  }

  return {
    isCursorHidden: () => cursorHidden,
    isSynchronizing: () => syncStartedAt !== null && now() - syncStartedAt < SYNC_TIMEOUT_MS,
    reset,
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
