// The workstation's terminal font in this window: whether this device has it,
// asking before fetching it, loading it from cache or from the host, and
// cutting a large fallback font to the characters actually drawn.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostFontSubsetSource, HostTerminalFont } from '@protocol/terminal';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import { STORAGE_KEYS } from '@/shared/lib/browserStorage';
import { COMMON_CJK_TEXT } from './commonCjk';
import {
  type CachedSubset,
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
import {
  COMMON_LATIN_TEXT,
  codepointsOf,
  type HostFontDeps,
  type HostFontState,
  type HostFontStatus,
  type HostGlyphState,
  type HostGlyphStatus,
  INITIAL,
  NO_GLYPHS,
  subsetSource,
} from './hostFontState';
import { useHostFontTransfer } from './useHostFontTransfer';

/** A font that arrives this soon after "sync" was asked for is loaded unasked. */
const SYNC_WINDOW_MS = 15_000;
/** Characters met while drawing are gathered this long, then fetched together. */
const GLYPH_BATCH_MS = 80;
/** Characters per on-demand cut; the rest wait for the next one. */
const MAX_GLYPHS_PER_CUT = 2000;

export function useHostFont(adapter: HerdrClientAdapter | null, deps: HostFontDeps = {}) {
  const [state, setState] = useState<HostFontState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Bumped whenever the font changes; late results of an older one are dropped. */
  const generationRef = useRef(0);
  const autoAcceptUntilRef = useRef(0);
  /** Characters held, asked for, and waiting to be asked for, for the current source. */
  const coveredRef = useRef(new Set<number>());
  const askedRef = useRef(new Set<number>());
  const wantedRef = useRef(new Set<number>());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { requestChunk, requestSubset, rejectPending } = useHostFontTransfer(adapter);

  const resolved = useCallback(
    () => ({
      isInstalled: depsRef.current.isInstalled ?? isFontInstalled,
      readCached: depsRef.current.readCached ?? readCachedFace,
      writeCached: depsRef.current.writeCached ?? writeCachedFace,
      register: depsRef.current.register ?? registerHostFontFaces,
      isRegistered: depsRef.current.isRegistered ?? isHostFontRegistered,
      readSubsets: depsRef.current.readSubsets ?? readCachedSubsets,
      writeSubset: depsRef.current.writeSubset ?? writeCachedSubset,
      registerGlyphs: depsRef.current.registerGlyphs ?? registerGlyphSubset,
    }),
    [],
  );

  const hostKey = useCallback(() => adapter?.getHostId() || 'default', [adapter]);

  const setGlyphs = useCallback((generation: number, patch: Partial<HostGlyphState>) => {
    if (generation !== generationRef.current) return;
    setState((previous) => ({ ...previous, glyphs: { ...previous.glyphs, ...patch } }));
  }, []);

  /** Registers cuts, remembers what they cover, and asks the terminal to repaint. */
  const addGlyphs = useCallback(
    async (generation: number, alias: string, subsets: CachedSubset[]) => {
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
    },
    [resolved],
  );

  /**
   * Fetches the common characters this device does not hold yet. Everything
   * after this arrives a few characters at a time, as it is drawn.
   */
  const prefetchGlyphs = useCallback(
    async (
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
    },
    [requestSubset, resolved, addGlyphs],
  );

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
    [requestChunk, prefetchGlyphs, resolved, hostKey, setGlyphs],
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
    [load, rejectPending, hostKey, setGlyphs, prefetchGlyphs, resolved, addGlyphs],
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
  }, [hostKey]);

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
    [requestSubset, resolved, addGlyphs],
  );

  useEffect(() => {
    if (!adapter) return undefined;
    const offFont = adapter.on('terminalFont', (font) => {
      void evaluate(font);
    });
    return () => {
      offFont();
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    };
  }, [adapter, evaluate]);

  // An answer given in another tab of this browser holds here too, so the
  // same question is not waiting in every window.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.hostFontConsent) return;
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
  }, [load, decline, hostKey]);

  return {
    hostFont: state,
    loadHostFont: load,
    declineHostFont: decline,
    syncHostFont: sync,
    ensureHostGlyphs: ensureGlyphs,
  };
}
