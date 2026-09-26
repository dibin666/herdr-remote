// Keystrokes on their way to the relay. Everything queued within one task
// goes out as a single frame, so a burst of wheel reports or a pasted run of
// keys costs one WebSocket message instead of dozens.

import { isWheelOnlyInput } from './scrollInput';

export class InputQueue {
  private segments: Uint8Array[] = [];
  private flushScheduled = false;

  constructor(private readonly getSocket: () => WebSocket | null) {}

  push(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length === 0) return;
    this.segments.push(bytes);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      // Microtask executes before yielding to the event loop, ensuring zero added latency
      // for single keystrokes while coalescing wheel events within the same macro gesture.
      queueMicrotask(() => this.flush());
    }
  }

  flush(): void {
    this.flushScheduled = false;
    if (this.segments.length === 0) return;

    let segments = this.segments;
    this.segments = [];

    const socket = this.getSocket();
    // Drop wheel reports when under backpressure (>256KB queued), keeping keystrokes intact.
    if (socket && (socket.bufferedAmount ?? 0) > 256 * 1024) {
      segments = segments.filter((seg) => !isWheelOnlyInput(seg));
    }

    if (segments.length === 0) return;

    let merged: Uint8Array;
    if (segments.length === 1) {
      merged = segments[0];
    } else {
      let totalLength = 0;
      for (let i = 0; i < segments.length; i++) {
        totalLength += segments[i].byteLength;
      }
      merged = new Uint8Array(totalLength);
      let offset = 0;
      for (let i = 0; i < segments.length; i++) {
        merged.set(segments[i], offset);
        offset += segments[i].byteLength;
      }
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(merged);
    }
  }

  /** Forget queued input, as its socket goes away. */
  clear(): void {
    this.segments = [];
    this.flushScheduled = false;
  }
}
