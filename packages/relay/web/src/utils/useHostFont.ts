import { useCallback, useEffect, useRef, useState } from 'react';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import type { HostFontSubsetSource, HostTerminalFont } from '../types/protocol';
import { COMMON_CJK_TEXT } from './commonCjk';
import {
  HOST_FONT_CONSENT_KEY,
  type CachedSubset,
  decodeBase64,
  downloadHostFontFace,
  hostFontAlias,
  hostFontBytes,
  hostFontFingerprint,
  hostGlyphAlias,
  isFontInstalled,
  isHostFontRegistered,
  loadHostFontDecision,
  readCachedFace,
  readCachedSubsets,
  registerGlyphSubset,
  registerHostFontFaces,
  saveHostFontDecision,
  wantsGlyph,
  writeCachedFace,
  writeCachedSubset,
} from './hostFont';

/**
 * Where the workstation's font stands in this window:
 *
 * - `none`: the host reported no font (unknown terminal, older host).
 * - `installed`: this device has the family; it is used by name.
 * - `loaded`: the host's files are registered (fetched now or from cache).
 * - `available`: files are offered and nobody has answered yet — ask.
 * - `declined`: the user chose this device's own fonts for this font.
 * - `loading` / `failed`: a transfer in progress, or one that did not finish.
 * - `unavailable`: no files to fetch (a font collection, or not on disk).
 */
export type HostFontStatus =
  | 'none'
  | 'checking'
  | 'installed'
  | 'loaded'
  | 'available'
  | 'declined'
  | 'loading'
  | 'failed'
  | 'unavailable';

/**
 * The large font (the CJK fallback, usually) this window receives cut to the
 * characters it draws. `ready` means common characters are in and rarer ones
 * are fetched as they appear.
 */
export type HostGlyphStatus =
  | 'none'
  | 'checking'
  | 'installed'
  | 'available'
  | 'declined'
  | 'loading'
  | 'ready'
  | 'failed';

export interface HostGlyphState {
  source: HostFontSubsetSource | null;
  status: HostGlyphStatus;
  /** The FontFace family the cuts are registered under, once one is. */
  alias: string | null;
  /** How many characters this device holds from the source. */
  covered: number;
}

export interface HostFontState {
  font: HostTerminalFont | null;
  status: HostFontStatus;
  /** The FontFace family of the fetched files, once registered. */
  alias: string | null;
  receivedBytes: number;
  totalBytes: number;
  /** A machine-readable reason when `failed`. */
  error: string | null;
  glyphs: HostGlyphState;
  /** A transfer the user started from the prompt, which shows its progress. */
  interactive: boolean;
  /** Bumped whenever glyphs are added under an unchanged family: repaint. */
  glyphRevision: number;
}

/** Seams for tests; the defaults are the real browser APIs. */
export interface HostFontDeps {
  isInstalled?: (family: string) => boolean;
  readCached?: typeof readCachedFace;
  writeCached?: typeof writeCachedFace;
  register?: typeof registerHostFontFaces;
  isRegistered?: typeof isHostFontRegistered;
  readSubsets?: typeof readCachedSubsets;
  writeSubset?: typeof writeCachedSubset;
  registerGlyphs?: typeof registerGlyphSubset;
}

const NO_GLYPHS: HostGlyphState = { source: null, status: 'none', alias: null, covered: 0 };

const INITIAL: HostFontState = {
  font: null,
  status: 'none',
  alias: null,
  receivedBytes: 0,
  totalBytes: 0,
  error: null,
  glyphs: NO_GLYPHS,
  interactive: false,
  glyphRevision: 0,
};

/** A slice that has not arrived by now is not coming. */
const CHUNK_TIMEOUT_MS = 30_000;
/** A font that arrives this soon after "sync" was asked for is loaded unasked. */
const SYNC_WINDOW_MS = 15_000;
/** Characters met while drawing are gathered this long, then fetched together. */
const GLYPH_BATCH_MS = 80;
/** Characters per on-demand cut; the rest wait for the next one. */
const MAX_GLYPHS_PER_CUT = 2000;

/** For a family cut for everything, what a terminal shows besides Hanzi. */
const COMMON_LATIN_TEXT = String.fromCodePoint(
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i),
  ...Array.from({ length: 0x2070 - 0x2000 }, (_, i) => 0x2000 + i),
);

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The cut source this window uses: the family itself over its CJK fallback. */
function subsetSource(font: HostTerminalFont | null): HostFontSubsetSource | null {
  const sources = font?.subsets ?? [];
  return (
    sources.find((source) => source.scope === 'all') ??
    sources.find((source) => source.scope === 'cjk') ??
    null
  );
}

function codepointsOf(text: string, scope: HostFontSubsetSource['scope']): number[] {
  const seen = new Set<number>();
  for (const char of text) {
    const codepoint = char.codePointAt(0) as number;
    if (wantsGlyph(scope, codepoint)) seen.add(codepoint);
  }
  return [...seen];
}

export function useHostFont(adapter: HerdrClientAdapter | null, deps: HostFontDeps = {}) {
  const [state, setState] = useState<HostFontState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Bumped whenever the font changes; late results of an older one are dropped. */
  const generationRef = useRef(0);
  const pendingRef = useRef(new Map<string, Pending<Uint8Array>>());
  const pendingSubsetsRef = useRef(new Map<string, Pending<CachedSubset>>());
  /** Byte progress of each pending cut, reported as its slices arrive. */
  const subsetProgressRef = useRef(new Map<string, (bytes: number, total: number) => void>());
  const autoAcceptUntilRef = useRef(0);
  /** Characters held, asked for, and waiting to be asked for, for the current source. */
  const coveredRef = useRef(new Set<number>());
  const askedRef = useRef(new Set<number>());
  const wantedRef = useRef(new Set<number>());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolved = () => ({
    isInstalled: depsRef.current.isInstalled ?? isFontInstalled,
    readCached: depsRef.current.readCached ?? readCachedFace,
    writeCached: depsRef.current.writeCached ?? writeCachedFace,
    register: depsRef.current.register ?? registerHostFontFaces,
    isRegistered: depsRef.current.isRegistered ?? isHostFontRegistered,
    readSubsets: depsRef.current.readSubsets ?? readCachedSubsets,
    writeSubset: depsRef.current.writeSubset ?? writeCachedSubset,
    registerGlyphs: depsRef.current.registerGlyphs ?? registerGlyphSubset,
  });

  const hostKey = () => adapter?.getHostId() || 'default';

  const setGlyphs = (generation: number, patch: Partial<HostGlyphState>) => {
    if (generation !== generationRef.current) return;
    setState((previous) => ({ ...previous, glyphs: { ...previous.glyphs, ...patch } }));
  };

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

  /** Registers cuts, remembers what they cover, and asks the terminal to repaint. */
  const addGlyphs = async (generation: number, alias: string, subsets: CachedSubset[]) => {
    const { registerGlyphs } = resolved();
    for (const subset of subsets) {
      await registerGlyphs(alias, subset);
      if (generation !== generationRef.current) return;
      for (const codepoint of subset.codepoints) coveredRef.current.add(codepoint);
    }
    if (generation !== generationRef.current || !subsets.length) return;
    setState((previous) => ({
      ...previous,
      glyphs: { ...previous.glyphs, alias, covered: coveredRef.current.size },
      glyphRevision: previous.glyphRevision + 1,
    }));
  };

  /**
   * Fetches the common characters this device does not hold yet. Everything
   * after this arrives a few characters at a time, as it is drawn.
   */
  const prefetchGlyphs = async (
    generation: number,
    source: HostFontSubsetSource,
    onBytes: (bytes: number, total: number) => void,
  ) => {
    const alias = hostGlyphAlias(source) as string;
    const common = source.scope === 'all' ? COMMON_LATIN_TEXT + COMMON_CJK_TEXT : COMMON_CJK_TEXT;
    const missing = codepointsOf(common, source.scope).filter(
      (codepoint) => !coveredRef.current.has(codepoint),
    );
    if (!missing.length) return;
    for (const codepoint of missing) askedRef.current.add(codepoint);
    const subset = await requestSubset(source, missing, onBytes);
    if (generation !== generationRef.current) return;
    await resolved().writeSubset(source.sha256, subset);
    await addGlyphs(generation, alias, [subset]);
  };

  const load = useCallback(
    async (target?: HostTerminalFont | null, { interactive = true } = {}) => {
      const font = target ?? stateRef.current.font;
      const fingerprint = hostFontFingerprint(font);
      if (!font || !fingerprint) return;
      const current = stateRef.current;
      const sameFont = hostFontFingerprint(current.font) === fingerprint;
      if (sameFont && (current.status === 'loading' || current.glyphs.status === 'loading')) return;

      const generation = generationRef.current;
      const { isInstalled, isRegistered, readCached, writeCached, register } = resolved();
      saveHostFontDecision(hostKey(), fingerprint, 'accepted');
      const alias = hostFontAlias(font);
      const source = subsetSource(font);
      const primaryNeeded = Boolean(alias && !isRegistered(alias) && !isInstalled(font.family));
      const glyphs = sameFont ? current.glyphs : { ...NO_GLYPHS, source };
      const glyphsNeeded = Boolean(
        source && !['installed', 'ready', 'none'].includes(glyphs.status),
      );

      let totalBytes = primaryNeeded ? hostFontBytes(font) : 0;
      let receivedBytes = 0;
      const progress = () => {
        if (generation === generationRef.current)
          setState((previous) => ({ ...previous, receivedBytes, totalBytes }));
      };
      setState((previous) => ({
        ...previous,
        font,
        interactive,
        receivedBytes: 0,
        totalBytes,
        error: null,
        status: primaryNeeded ? 'loading' : previous.status,
        glyphs: glyphsNeeded ? { ...glyphs, status: 'loading' } : glyphs,
      }));

      if (primaryNeeded && alias) {
        try {
          const entries = [];
          for (const face of font.faces) {
            let data = await readCached(face.sha256);
            if (data) {
              receivedBytes += face.bytes;
              progress();
            } else {
              data = await downloadHostFontFace(face, requestChunk, (bytes) => {
                receivedBytes += bytes;
                progress();
              });
              await writeCached(face.sha256, data);
            }
            if (generation !== generationRef.current) return;
            entries.push({ face, data });
          }
          await register(alias, entries);
          if (generation !== generationRef.current) return;
          setState((previous) => ({ ...previous, status: 'loaded', alias }));
        } catch (error) {
          if (generation !== generationRef.current) return;
          const reason =
            error instanceof Error && error.message ? error.message : 'host_font_failed';
          setState((previous) => ({ ...previous, status: 'failed', alias: null, error: reason }));
        }
      }

      if (glyphsNeeded && source) {
        let announced = 0;
        try {
          await prefetchGlyphs(generation, source, (bytes, total) => {
            if (total && !announced) {
              announced = total;
              totalBytes += total;
            }
            receivedBytes += bytes;
            progress();
          });
          setGlyphs(generation, { status: 'ready' });
        } catch (error) {
          if (generation !== generationRef.current) return;
          const reason =
            error instanceof Error && error.message ? error.message : 'host_font_failed';
          setState((previous) => ({
            ...previous,
            error: previous.error ?? reason,
            glyphs: { ...previous.glyphs, status: 'failed' },
          }));
        }
      }
    },
    [requestChunk, requestSubset],
  );

  /** Decide what to do with a font the workstation reported. */
  const evaluate = useCallback(
    async (font: HostTerminalFont | null) => {
      const changed = hostFontFingerprint(font) !== hostFontFingerprint(stateRef.current.font);
      if (changed) {
        rejectPending('superseded');
        coveredRef.current = new Set();
        askedRef.current = new Set();
        wantedRef.current = new Set();
      }
      const generation = ++generationRef.current;
      if (!font) {
        setState(INITIAL);
        return;
      }
      const { isInstalled, readCached, register, isRegistered, readSubsets } = resolved();
      const alias = hostFontAlias(font);
      const fingerprint = hostFontFingerprint(font) as string;
      const source = subsetSource(font);

      let primary: HostFontStatus | 'needs' = 'checking';
      if (alias && isRegistered(alias)) primary = 'loaded';
      else if (isInstalled(font.family)) primary = 'installed';
      else if (!alias) primary = 'unavailable';

      let glyphs: HostGlyphStatus | 'needs' | 'cached' = 'checking';
      if (!source) glyphs = 'none';
      else if (source.scope === 'cjk' ? isInstalled(source.family) : primary === 'installed')
        glyphs = 'installed';

      setState((previous) => ({
        ...INITIAL,
        font,
        status: primary === 'checking' ? 'checking' : (primary as HostFontStatus),
        alias: primary === 'loaded' ? alias : null,
        totalBytes: hostFontBytes(font),
        glyphs: {
          source,
          status: glyphs as HostGlyphStatus,
          alias: changed ? null : previous.glyphs.alias,
          covered: coveredRef.current.size,
        },
        glyphRevision: previous.glyphRevision,
      }));

      // Fetched before, on this device: no question, no transfer.
      if (primary === 'checking' && alias) {
        const cached = await Promise.all(font.faces.map((face) => readCached(face.sha256)));
        if (generation !== generationRef.current) return;
        primary = 'needs';
        if (cached.every(Boolean)) {
          try {
            await register(
              alias,
              font.faces.map((face, index) => ({ face, data: cached[index] as ArrayBuffer })),
            );
            if (generation !== generationRef.current) return;
            primary = 'loaded';
            setState((previous) => ({ ...previous, status: 'loaded', alias }));
          } catch {
            // A cached copy the browser refuses is fetched again.
          }
        }
      }
      if (glyphs === 'checking' && source) {
        const cuts = await readSubsets(source.sha256);
        if (generation !== generationRef.current) return;
        if (cuts.length) {
          try {
            await addGlyphs(generation, hostGlyphAlias(source) as string, cuts);
            glyphs = 'cached';
          } catch {
            glyphs = 'needs';
          }
        } else {
          glyphs = 'needs';
        }
        if (generation !== generationRef.current) return;
      }

      const decision = loadHostFontDecision(hostKey(), fingerprint);
      // Held cuts mean this device said yes before; finish what it started.
      const accepted =
        decision === 'accepted' || glyphs === 'cached' || Date.now() < autoAcceptUntilRef.current;
      if (glyphs === 'cached') {
        glyphs = 'ready';
        setGlyphs(generation, { status: 'ready' });
        void prefetchGlyphs(generation, source as HostFontSubsetSource, () => {}).catch(() => {});
      }
      if (primary !== 'needs' && glyphs !== 'needs') return;
      if (accepted) {
        void load(font, { interactive: false });
        return;
      }
      const answer = decision === 'declined' ? 'declined' : 'available';
      setState((previous) => ({
        ...previous,
        status: primary === 'needs' ? answer : previous.status,
        glyphs: glyphs === 'needs' ? { ...previous.glyphs, status: answer } : previous.glyphs,
      }));
    },
    [load, rejectPending],
  );

  const decline = useCallback(() => {
    const fingerprint = hostFontFingerprint(stateRef.current.font);
    if (fingerprint) saveHostFontDecision(hostKey(), fingerprint, 'declined');
    setState((previous) => ({
      ...previous,
      interactive: false,
      status: ['available', 'failed'].includes(previous.status) ? 'declined' : previous.status,
      glyphs: ['available', 'failed'].includes(previous.glyphs.status)
        ? { ...previous.glyphs, status: 'declined' }
        : previous.glyphs,
    }));
  }, []);

  /**
   * "Sync host font": have the workstation re-read its terminal settings, and
   * load whatever it reports — the current font now, a changed one when the
   * answer arrives.
   */
  const sync = useCallback(() => {
    autoAcceptUntilRef.current = Date.now() + SYNC_WINDOW_MS;
    adapter?.sendHostFontRefresh();
    const current = stateRef.current;
    const retry = ['available', 'declined', 'failed'];
    if (current.font && (retry.includes(current.status) || retry.includes(current.glyphs.status))) {
      void load(current.font, { interactive: false });
    }
  }, [adapter, load]);

  /**
   * Characters the terminal is about to draw. Any the cut font should supply
   * and this device does not hold yet are fetched together, shortly after.
   */
  const ensureGlyphs = useCallback(
    (text: string) => {
      const { glyphs } = stateRef.current;
      if (glyphs.status !== 'ready' || !glyphs.source) return;
      const source = glyphs.source;
      for (const char of text) {
        const codepoint = char.codePointAt(0) as number;
        if (codepoint < 0x80 && source.scope !== 'all') continue;
        if (!wantsGlyph(source.scope, codepoint)) continue;
        if (coveredRef.current.has(codepoint) || askedRef.current.has(codepoint)) continue;
        wantedRef.current.add(codepoint);
      }
      if (!wantedRef.current.size || batchTimerRef.current) return;
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null;
        const generation = generationRef.current;
        const batch = [...wantedRef.current].slice(0, MAX_GLYPHS_PER_CUT);
        for (const codepoint of batch) {
          wantedRef.current.delete(codepoint);
          askedRef.current.add(codepoint);
        }
        void (async () => {
          const subset = await requestSubset(source, batch, () => {});
          if (generation !== generationRef.current) return;
          await resolved().writeSubset(source.sha256, subset);
          await addGlyphs(generation, hostGlyphAlias(source) as string, [subset]);
        })().catch(() => {
          // Asked once per page; a character that failed falls back to this
          // device's font rather than being asked for on every frame.
        });
      }, GLYPH_BATCH_MS);
    },
    [requestSubset],
  );

  useEffect(() => {
    if (!adapter) return undefined;
    const pending = pendingRef.current;
    const pendingSubsets = pendingSubsetsRef.current;
    const offFont = adapter.on('terminalFont', (font) => {
      void evaluate(font);
    });
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
      offFont();
      offChunk();
      offSubset();
      offError();
      offState();
      rejectPending('disconnected');
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    };
  }, [adapter, evaluate, rejectPending, requestChunk]);

  // An answer given in another tab of this browser holds here too, so the
  // same question is not waiting in every window.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== HOST_FONT_CONSENT_KEY) return;
      const current = stateRef.current;
      const fingerprint = hostFontFingerprint(current.font);
      const asking = current.status === 'available' || current.glyphs.status === 'available';
      if (!fingerprint || !asking) return;
      const decision = loadHostFontDecision(hostKey(), fingerprint);
      if (decision === 'accepted') void load(current.font, { interactive: false });
      else if (decision === 'declined') decline();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [load, decline]);

  return {
    hostFont: state,
    loadHostFont: load,
    declineHostFont: decline,
    syncHostFont: sync,
    ensureHostGlyphs: ensureGlyphs,
  };
}
