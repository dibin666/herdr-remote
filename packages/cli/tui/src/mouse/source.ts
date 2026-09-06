import { PassThrough } from 'node:stream';
import { createMouseSplitter, DISABLE_MOUSE, ENABLE_MOUSE, type MouseEvent } from './protocol.js';

export type MouseSource = {
  /** Stream to hand to Ink in place of the real stdin. */
  stdin: NodeJS.ReadStream;
  supported: boolean;
  isEnabled: () => boolean;
  enable: () => void;
  disable: () => void;
  subscribe: (listener: (event: MouseEvent) => void) => () => void;
  dispose: () => void;
};

/**
 * Read the real stdin, peel off mouse reports, and forward the rest to Ink.
 *
 * Ink and the mouse layer cannot both own stdin: whoever reads it first
 * consumes the bytes. So this reads it once, routes mouse reports to
 * subscribers, and republishes the remaining keystrokes on a stream that looks
 * enough like a TTY for Ink to drive.
 */
export function createMouseSource(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): MouseSource {
  const supported = Boolean(input.isTTY && output.isTTY);
  const listeners = new Set<(event: MouseEvent) => void>();
  const split = createMouseSplitter();
  const forwarded = new PassThrough();

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { events, passthrough } = split(text);
    for (const event of events) {
      for (const listener of listeners) listener(event);
    }
    if (passthrough.length > 0) forwarded.write(passthrough);
  };

  if (supported) input.on('data', onData);

  // Ink expects a TTY: it checks isTTY and drives raw mode itself. Delegate
  // those to the real stdin while it reads from our filtered copy.
  const stdin = forwarded as unknown as NodeJS.ReadStream;
  stdin.isTTY = input.isTTY;
  stdin.setRawMode = ((mode: boolean) => {
    input.setRawMode?.(mode);
    return stdin;
  }) as NodeJS.ReadStream['setRawMode'];
  stdin.ref = (() => { input.ref?.(); return stdin; }) as NodeJS.ReadStream['ref'];
  stdin.unref = (() => { input.unref?.(); return stdin; }) as NodeJS.ReadStream['unref'];

  let enabled = false;
  const enable = () => {
    if (!supported || enabled) return;
    output.write(ENABLE_MOUSE);
    enabled = true;
  };
  const disable = () => {
    if (!enabled) return;
    output.write(DISABLE_MOUSE);
    enabled = false;
  };

  return {
    stdin,
    supported,
    isEnabled: () => enabled,
    enable,
    disable,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disable();
      listeners.clear();
      if (supported) input.off('data', onData);
    },
  };
}
