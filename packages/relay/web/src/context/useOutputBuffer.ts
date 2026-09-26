// Raw PTY output between the relay and the terminal. It lives at provider
// scope so that unmounting or hiding TerminalView never drops a chunk: with no
// sink attached the stream is buffered in arrival order and replayed on
// re-attach.

import { useCallback, useRef } from 'react';

/** Ring-buffer bounds for output received while no terminal sink is attached. */
export const MAX_PENDING_OUTPUT_CHUNKS = 4096;
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

export type TerminalOutputSink = (data: Uint8Array) => void;

export function useOutputBuffer() {
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

  /** A chunk from the relay: straight to the terminal, or into the buffer. */
  const receiveOutput = useCallback(
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
    [enqueueOutput],
  );

  /**
   * Attach the live xterm instance as the sink for raw PTY output.
   * Anything buffered while no sink was attached is flushed, in arrival order,
   * before the sink starts receiving live chunks. Returns an unsubscribe fn
   * that puts the stream back into buffering mode.
   */
  const subscribeToOutput = useCallback(
    (sink: TerminalOutputSink) => {
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
    },
    [enqueueOutput],
  );

  /** Number of chunks currently buffered (diagnostics / tests). */
  const getPendingOutputChunkCount = useCallback(() => pendingOutputRef.current.length, []);

  const clearPendingOutput = useCallback(() => {
    pendingOutputRef.current = [];
    pendingOutputBytesRef.current = 0;
  }, []);

  return { receiveOutput, subscribeToOutput, getPendingOutputChunkCount, clearPendingOutput };
}
