// Herdr fences every frame in `?2026` (synchronized output). Rows xterm asks
// to paint while a frame is still arriving are held, and painted with the
// rest once it ends, or once `maxHoldMs` passes without an end.

export interface RowRange {
  start: number;
  end: number;
}

export class SyncHold {
  private startedAt: number | null = null;
  private held: RowRange | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly now: () => number,
    private readonly maxHoldMs: number,
    /** The hold ran out: the held rows should be painted now. */
    private readonly onExpire: () => void,
  ) {}

  /** The rows held so far, if any. */
  get pending(): RowRange | null {
    return this.held;
  }

  /** Holds `start`–`end` while the frame may still wait; false once it must be painted. */
  hold(start: number, end: number): boolean {
    const now = this.now();
    if (this.startedAt === null) this.startedAt = now;
    if (now - this.startedAt >= this.maxHoldMs) return false;
    this.held = this.held
      ? { start: Math.min(this.held.start, start), end: Math.max(this.held.end, end) }
      : { start, end };
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.onExpire();
      }, this.maxHoldMs);
    }
    return true;
  }

  /** Ends the hold: `start`–`end`, widened to every row that was held. */
  release(start: number, end: number): RowRange {
    if (this.held) {
      start = Math.min(start, this.held.start);
      end = Math.max(end, this.held.end);
    }
    this.held = null;
    this.startedAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return { start, end };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
