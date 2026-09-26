// Pulling font bytes from the workstation: whole files in slices, and cuts
// of a large font made to order. Requests wait for their answer by key and
// give up after a while, on disconnect, or when the host says no.

import { useCallback, useEffect, useRef } from 'react';
import type { HostFontSubsetSource } from '@protocol/terminal';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import { type CachedSubset, decodeBase64, downloadHostFontFace } from './hostFont';

/** A slice that has not arrived by now is not coming. */
const CHUNK_TIMEOUT_MS = 30_000;

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function useHostFontTransfer(adapter: HerdrClientAdapter | null) {
  const pendingRef = useRef(new Map<string, Pending<Uint8Array>>());
  const pendingSubsetsRef = useRef(new Map<string, Pending<CachedSubset>>());
  /** Byte progress of each pending cut, reported as its slices arrive. */
  const subsetProgressRef = useRef(new Map<string, (bytes: number, total: number) => void>());

  const rejectPending = useCallback((reason: string) => {
    for (const map of [pendingRef.current, pendingSubsetsRef.current] as Array<
      Map<string, Pending<unknown>>
    >) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      map.clear();
    }
  }, []);

  const requestChunk = useCallback(
    (sha256: string, index: number) =>
      new Promise<Uint8Array>((resolve, reject) => {
        if (!adapter) {
          reject(new Error('disconnected'));
          return;
        }
        const key = `${sha256}:${index}`;
        const timer = setTimeout(() => {
          pendingRef.current.delete(key);
          reject(new Error('host_font_timeout'));
        }, CHUNK_TIMEOUT_MS);
        pendingRef.current.set(key, { resolve, reject, timer });
        adapter.sendHostFontChunkRequest(sha256, index);
      }),
    [adapter],
  );

  /**
   * Has the workstation cut `codepoints` out of `source`. A small cut arrives
   * with the answer; a large one is pulled in slices like a font file.
   */
  const requestSubset = useCallback(
    (
      source: HostFontSubsetSource,
      codepoints: number[],
      onBytes: (bytes: number, total: number) => void,
    ) =>
      new Promise<CachedSubset>((resolve, reject) => {
        if (!adapter) {
          reject(new Error('disconnected'));
          return;
        }
        const requestId = Math.random().toString(36).slice(2, 12);
        const timer = setTimeout(() => {
          pendingSubsetsRef.current.delete(requestId);
          reject(new Error('host_font_timeout'));
        }, CHUNK_TIMEOUT_MS);
        pendingSubsetsRef.current.set(requestId, {
          resolve: (subset) => resolve({ ...subset, codepoints }),
          reject,
          timer,
        });
        subsetProgressRef.current.set(requestId, onBytes);
        adapter.sendHostFontSubsetRequest(
          source.sha256,
          String.fromCodePoint(...codepoints),
          requestId,
        );
      }),
    [adapter],
  );

  useEffect(() => {
    if (!adapter) return undefined;
    const pending = pendingRef.current;
    const pendingSubsets = pendingSubsetsRef.current;
    const offChunk = adapter.on('hostFontChunk', (message) => {
      const key = `${message.sha256}:${message.index}`;
      const waiting = pending.get(key);
      if (!waiting) return;
      pending.delete(key);
      clearTimeout(waiting.timer);
      try {
        waiting.resolve(decodeBase64(message.dataBase64));
      } catch {
        waiting.reject(new Error('host_font_corrupt'));
      }
    });
    const offSubset = adapter.on('hostFontSubset', (message) => {
      const waiting = pendingSubsets.get(message.requestId);
      if (!waiting) return;
      pendingSubsets.delete(message.requestId);
      clearTimeout(waiting.timer);
      const onBytes = subsetProgressRef.current.get(message.requestId) ?? (() => {});
      subsetProgressRef.current.delete(message.requestId);
      if (message.dataBase64 !== undefined) {
        try {
          const bytes = decodeBase64(message.dataBase64);
          onBytes(bytes.length, bytes.length);
          waiting.resolve({
            subsetSha: message.subsetSha,
            data: bytes.buffer as ArrayBuffer,
            codepoints: [],
          });
        } catch {
          waiting.reject(new Error('host_font_corrupt'));
        }
        return;
      }
      onBytes(0, message.bytes);
      const face = {
        style: 'regular' as const,
        format: 'opentype' as const,
        bytes: message.bytes,
        sha256: message.subsetSha,
      };
      downloadHostFontFace(face, requestChunk, (bytes) => onBytes(bytes, message.bytes))
        .then((data) => waiting.resolve({ subsetSha: message.subsetSha, data, codepoints: [] }))
        .catch((error) =>
          waiting.reject(error instanceof Error ? error : new Error('host_font_failed')),
        );
    });
    const offError = adapter.on('error', (error) => {
      if (error.code === 'host_font_unavailable' || error.code === 'host_font_subset_failed') {
        rejectPending(String(error.code));
      }
    });
    const offState = adapter.on('stateChange', (next) => {
      if (next !== 'connected') rejectPending('disconnected');
    });
    return () => {
      offChunk();
      offSubset();
      offError();
      offState();
      rejectPending('disconnected');
    };
  }, [adapter, rejectPending, requestChunk]);

  return { requestChunk, requestSubset, rejectPending };
}
