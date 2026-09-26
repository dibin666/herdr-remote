import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, renderHook, act, waitFor, screen, fireEvent } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import { HostFontPrompt } from '../components/HostFontPrompt';
import { SettingsModal } from '../components/SettingsModal';
import type { HostFontDeps } from '../utils/hostFontState';
import { useHostFont } from '../utils/useHostFont';
import { HOST_FONT_CHUNK_BYTES, hostFontAlias } from '../utils/hostFont';
import { loadSettings } from '../utils/storage';
import { STORAGE_KEYS } from '../utils/browserStorage';
import { resolveTerminalFontFamily } from '../utils/theme';
import { COMMON_CJK_TEXT } from '../utils/commonCjk';
import type { HerdrClientAdapter } from '../protocol/clientAdapter';
import type { HostTerminalFont } from '@protocol/terminal';
import type { MockTerminalInstance } from './setup';

/**
 * The session is drawn in the workstation terminal's own font. A device that
 * has the family uses it by name; one that does not is asked once, then
 * fetches the files a slice at a time and keeps them.
 */

const REGULAR = '0ec29a68b539ece7078fc714cebff0c0accb2f4948f8f7963d9f5e86633b12d9';
const BOLD = 'e82e27a7f37c9a0a13cc4e417503a149c6a0280586930772d2ebed803159c864';

const FONT: HostTerminalFont = {
  family: 'JetBrainsMono Nerd Font',
  sizePx: 12,
  source: 'gnome-terminal',
  faces: [
    { style: 'regular', format: 'truetype', bytes: HOST_FONT_CHUNK_BYTES + 10, sha256: REGULAR },
    { style: 'bold', format: 'truetype', bytes: 20, sha256: BOLD },
  ],
};

type Listener = (...args: unknown[]) => void;

/** Just enough adapter: events in, font requests out, answered by `serve`. */
function fakeAdapter(
  serve: (sha256: string, index: number) => { dataBase64?: string; error?: string },
) {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.forEach((fn) => fn(...args));
  const requests: Array<[string, number]> = [];
  let refreshes = 0;
  const adapter = {
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)!.delete(fn);
    },
    getHostId: () => 'host-1',
    sendHostFontChunkRequest(sha256: string, index: number) {
      requests.push([sha256, index]);
      const answer = serve(sha256, index);
      queueMicrotask(() => {
        if (answer.error) emit('error', { code: answer.error, message: '' });
        else
          emit('hostFontChunk', {
            type: 'host_font_chunk',
            sha256,
            index,
            total: 1,
            dataBase64: answer.dataBase64,
          });
      });
    },
    sendHostFontRefresh() {
      refreshes += 1;
    },
  };
  return {
    adapter: adapter as unknown as HerdrClientAdapter,
    emit,
    requests,
    refreshes: () => refreshes,
  };
}

/** Serves each slice as the right number of zero bytes. */
function serveZeros(font: HostTerminalFont) {
  return (sha256: string, index: number) => {
    const face = font.faces.find((candidate) => candidate.sha256 === sha256)!;
    const length = Math.min(HOST_FONT_CHUNK_BYTES, face.bytes - index * HOST_FONT_CHUNK_BYTES);
    return { dataBase64: btoa('\0'.repeat(length)) };
  };
}

function fakeDeps(overrides: Partial<HostFontDeps> = {}) {
  const cache = new Map<string, ArrayBuffer>();
  const registered: Array<{ alias: string; sizes: number[] }> = [];
  const deps: HostFontDeps = {
    isInstalled: () => false,
    readCached: async (sha256) => cache.get(sha256) ?? null,
    writeCached: async (sha256, data) => {
      cache.set(sha256, data);
    },
    register: async (alias, faces) => {
      registered.push({ alias, sizes: faces.map(({ data }) => data.byteLength) });
    },
    isRegistered: () => false,
    ...overrides,
  };
  return { deps, cache, registered };
}

describe('useHostFont', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses a family this device has by name, without asking or fetching', async () => {
    const wire = fakeAdapter(serveZeros(FONT));
    const { deps } = fakeDeps({ isInstalled: (family) => family === FONT.family });
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));

    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(result.current.hostFont.status).toBe('installed'));
    expect(wire.requests).toEqual([]);
  });

  it('asks first, then fetches every slice, caches and registers the faces', async () => {
    const wire = fakeAdapter(serveZeros(FONT));
    const { deps, cache, registered } = fakeDeps();
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));

    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(result.current.hostFont.status).toBe('available'));
    expect(wire.requests).toEqual([]);

    await act(async () => {
      await result.current.loadHostFont();
    });
    expect(result.current.hostFont.status).toBe('loaded');
    expect(result.current.hostFont.alias).toBe(hostFontAlias(FONT));
    expect(wire.requests).toEqual([
      [REGULAR, 0],
      [REGULAR, 1],
      [BOLD, 0],
    ]);
    expect(registered).toEqual([
      { alias: hostFontAlias(FONT), sizes: [HOST_FONT_CHUNK_BYTES + 10, 20] },
    ]);
    expect(cache.size).toBe(2);
  });

  it('remembers the answer: cached files load silently, a refusal is not asked again', async () => {
    const wire = fakeAdapter(serveZeros(FONT));
    const { deps } = fakeDeps();
    const first = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(first.result.current.hostFont.status).toBe('available'));
    await act(async () => {
      await first.result.current.loadHostFont();
    });
    first.unmount();

    // A later visit: same font, files already on this device.
    const again = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(again.result.current.hostFont.status).toBe('loaded'));
    expect(wire.requests.length).toBe(3);
    again.unmount();

    // A refused font stays refused; a different font is a new question.
    localStorage.clear();
    const other = fakeDeps();
    const refused = renderHook(() => useHostFont(wire.adapter, other.deps));
    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(refused.result.current.hostFont.status).toBe('available'));
    act(() => refused.result.current.declineHostFont());
    act(() => wire.emit('terminalFont', { ...FONT }));
    await waitFor(() => expect(refused.result.current.hostFont.status).toBe('declined'));
    act(() =>
      wire.emit('terminalFont', { ...FONT, faces: [{ ...FONT.faces[0], sha256: 'f'.repeat(64) }] }),
    );
    await waitFor(() => expect(refused.result.current.hostFont.status).toBe('available'));
  });

  it('reports a transfer the host could not serve', async () => {
    const wire = fakeAdapter(() => ({ error: 'host_font_unavailable' }));
    const { deps } = fakeDeps();
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(result.current.hostFont.status).toBe('available'));

    await act(async () => {
      await result.current.loadHostFont();
    });
    expect(result.current.hostFont.status).toBe('failed');
    expect(result.current.hostFont.error).toBe('host_font_unavailable');
  });

  it('sync asks the host to re-read its font and loads it even after a refusal', async () => {
    const wire = fakeAdapter(serveZeros(FONT));
    const { deps, registered } = fakeDeps();
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', FONT));
    await waitFor(() => expect(result.current.hostFont.status).toBe('available'));
    act(() => result.current.declineHostFont());

    await act(async () => {
      result.current.syncHostFont();
    });
    await waitFor(() => expect(result.current.hostFont.status).toBe('loaded'));
    expect(wire.refreshes()).toBe(1);
    expect(registered.length).toBe(1);
  });

  it('a font with no files to fetch is drawn by name where installed', async () => {
    const wire = fakeAdapter(serveZeros(FONT));
    const { deps } = fakeDeps();
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', { family: 'Sarasa Mono SC', sizePx: 14, faces: [] }));
    await waitFor(() => expect(result.current.hostFont.status).toBe('unavailable'));
  });
});

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;

let terminalCtx: ReturnType<typeof useTerminal> | undefined;
const CaptureContext: React.FC = () => {
  terminalCtx = useTerminal();
  return null;
};

const sendReady = (terminalFont: HostTerminalFont | null) =>
  act(() => {
    // @ts-expect-error emit is private; the relay drives it over the wire
    terminalCtx?.adapter?.emit('ready', {
      type: 'ready',
      role: 'controller',
      hostId: 'host-1',
      hostname: 'workstation',
      terminalFont,
    });
    // @ts-expect-error emit is private; the relay drives it over the wire
    terminalCtx?.adapter?.emit('terminalFont', terminalFont);
  });

describe('Host terminal font in the window', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    // jsdom has no canvas: no family counts as installed here.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('draws the terminal in the host family at the host size', async () => {
    render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>,
    );
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    sendReady({ ...FONT, sizePx: 17 });
    await waitFor(() => expect(term.options.fontSize).toBe(17));
    expect(
      String(term.options.fontFamily).startsWith(
        '"JetBrainsMono Nerd Font", "Herdr JetBrains Mono"',
      ),
    ).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--tui-font')).toBe(
      term.options.fontFamily,
    );
  });

  it('asks once, names the terminal, and stays quiet after "use this device’s fonts"', async () => {
    render(
      <TerminalProvider>
        <CaptureContext />
        <HostFontPrompt />
      </TerminalProvider>,
    );
    sendReady(FONT);

    const prompt = await screen.findByTestId('host-font-prompt');
    expect(prompt.textContent).toContain('JetBrainsMono Nerd Font');
    expect(prompt.textContent).toContain('12px, GNOME Terminal');
    expect(prompt.textContent).toContain('2 font file(s), 256 KB');

    fireEvent.click(screen.getByRole('button', { name: /Use this device’s fonts/ }));
    await waitFor(() => expect(screen.queryByTestId('host-font-prompt')).not.toBeInTheDocument());
    expect(terminalCtx?.hostFont.status).toBe('declined');
  });

  it('does not ask while another font is chosen', async () => {
    sessionStorage.setItem(STORAGE_KEYS.sessionView, JSON.stringify({ fontFamily: 'fira-code' }));
    render(
      <TerminalProvider>
        <CaptureContext />
        <HostFontPrompt />
      </TerminalProvider>,
    );
    expect(terminalCtx?.settings.fontFamily).toBe('fira-code');
    sendReady(FONT);
    await waitFor(() => expect(terminalCtx?.hostFont.status).toBe('available'));
    expect(screen.queryByTestId('host-font-prompt')).not.toBeInTheDocument();
  });

  it('settings show the host font and moving the size slider stops following it', async () => {
    render(
      <TerminalProvider>
        <CaptureContext />
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );
    sendReady(FONT);
    await waitFor(() =>
      expect(screen.getByTestId('host-font-status').textContent).toBe(
        'JetBrainsMono Nerd Font · 12px · GNOME Terminal · Not loaded',
      ),
    );
    expect(screen.getByRole('button', { name: /Sync host font/ })).toBeInTheDocument();

    const follow = screen.getByLabelText(
      /Same size as the workstation terminal \(12px\)/,
    ) as HTMLInputElement;
    expect(follow.checked).toBe(true);
    expect(terminalCtx?.terminalFontSize).toBe(12);

    fireEvent.change(document.getElementById('terminal-font-size')!, { target: { value: '18' } });
    expect(loadSettings().fontSizeFollowsHost).toBe(false);
    expect(terminalCtx?.terminalFontSize).toBe(18);
  });
});

describe('useHostFont: a large CJK font, cut to what is drawn', () => {
  const CJK_SOURCE = {
    family: 'Noto Sans CJK SC',
    style: 'regular' as const,
    scope: 'cjk' as const,
    sha256: 'c'.repeat(64),
  };
  const WITH_CJK: HostTerminalFont = { ...FONT, subsets: [CJK_SOURCE] };
  /** 3,755 common Hanzi plus CJK punctuation and full-width forms. */
  const COMMON_COUNT = new Set(COMMON_CJK_TEXT).size;

  beforeEach(() => {
    localStorage.clear();
  });

  /** An adapter that also cuts: small cuts inline, large ones in slices. */
  function cuttingAdapter({ inlineLimit = Infinity } = {}) {
    const wire = fakeAdapter(serveZeros(FONT));
    const cuts: string[] = [];
    const held = new Map<string, number>();
    const adapter = wire.adapter as unknown as Record<string, unknown>;
    const serveChunk = adapter.sendHostFontChunkRequest as (sha256: string, index: number) => void;
    adapter.sendHostFontSubsetRequest = (sha256: string, text: string, requestId: string) => {
      cuts.push(text);
      const bytes = [...text].length * 10;
      const subsetSha = String(cuts.length).padStart(64, '0');
      queueMicrotask(() => {
        if (bytes <= inlineLimit) {
          wire.emit('hostFontSubset', {
            type: 'host_font_subset_ready',
            requestId,
            sha256,
            subsetSha,
            bytes,
            dataBase64: btoa('\0'.repeat(bytes)),
          });
        } else {
          held.set(subsetSha, bytes);
          wire.emit('hostFontSubset', {
            type: 'host_font_subset_ready',
            requestId,
            sha256,
            subsetSha,
            bytes,
          });
        }
      });
    };
    adapter.sendHostFontChunkRequest = (sha256: string, index: number) => {
      const bytes = held.get(sha256);
      if (bytes === undefined) return serveChunk(sha256, index);
      const length = Math.min(HOST_FONT_CHUNK_BYTES, bytes - index * HOST_FONT_CHUNK_BYTES);
      wire.requests.push([sha256, index]);
      queueMicrotask(() =>
        wire.emit('hostFontChunk', {
          type: 'host_font_chunk',
          sha256,
          index,
          total: 1,
          dataBase64: btoa('\0'.repeat(length)),
        }),
      );
    };
    return { ...wire, cuts };
  }

  function glyphDeps(installed: string[] = []) {
    const subsets = new Map<
      string,
      Array<{ subsetSha: string; data: ArrayBuffer; codepoints: number[] }>
    >();
    const glyphs: Array<{ alias: string; codepoints: number[]; bytes: number }> = [];
    const { deps } = fakeDeps({
      isInstalled: (family) => installed.includes(family),
      readSubsets: async (sha256) => subsets.get(sha256) ?? [],
      writeSubset: async (sha256, subset) => {
        subsets.set(sha256, [...(subsets.get(sha256) ?? []), subset]);
      },
      registerGlyphs: async (alias, subset) => {
        glyphs.push({ alias, codepoints: subset.codepoints, bytes: subset.data.byteLength });
      },
    });
    return { deps, subsets, glyphs };
  }

  it('asks once for the common characters, then fetches rare ones as they are drawn', async () => {
    const wire = cuttingAdapter();
    const { deps, glyphs } = glyphDeps([FONT.family]);
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));

    act(() => wire.emit('terminalFont', WITH_CJK));
    await waitFor(() => expect(result.current.hostFont.glyphs.status).toBe('available'));
    // The Latin family is on this device; only the CJK part is asked about.
    expect(result.current.hostFont.status).toBe('installed');

    await act(async () => {
      await result.current.loadHostFont();
    });
    expect(result.current.hostFont.glyphs.status).toBe('ready');
    expect([...wire.cuts[0]].length).toBe(COMMON_COUNT);
    expect(glyphs[0].alias).toBe('Herdr Glyphs cccccccccccc');
    const covered = result.current.hostFont.glyphs.covered;
    expect(covered).toBeGreaterThan(3800);

    // Drawn text: ASCII and characters already held are never asked for.
    const revision = result.current.hostFont.glyphRevision;
    act(() => result.current.ensureHostGlyphs('ls 你好 龘靐 ok 龘'));
    await waitFor(() => expect(wire.cuts.length).toBe(2));
    expect(wire.cuts[1]).toBe('龘靐');
    await waitFor(() => expect(result.current.hostFont.glyphRevision).toBe(revision + 1));
    expect(result.current.hostFont.glyphs.covered).toBe(covered + 2);

    // Asked once per page, even if it is drawn again.
    act(() => result.current.ensureHostGlyphs('龘靐'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wire.cuts.length).toBe(2);
  });

  it('a large cut is pulled in slices', async () => {
    const wire = cuttingAdapter({ inlineLimit: 1000 });
    const { deps, glyphs } = glyphDeps([FONT.family]);
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', WITH_CJK));
    await waitFor(() => expect(result.current.hostFont.glyphs.status).toBe('available'));

    await act(async () => {
      await result.current.loadHostFont();
    });
    expect(result.current.hostFont.glyphs.status).toBe('ready');
    expect(wire.requests.length).toBe(1);
    expect(glyphs[0].bytes).toBe(COMMON_COUNT * 10);
    expect(result.current.hostFont.totalBytes).toBe(COMMON_COUNT * 10);
  });

  it('cuts kept on this device load silently next time', async () => {
    const wire = cuttingAdapter();
    const { deps, glyphs } = glyphDeps([FONT.family]);
    const first = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', WITH_CJK));
    await waitFor(() => expect(first.result.current.hostFont.glyphs.status).toBe('available'));
    await act(async () => {
      await first.result.current.loadHostFont();
    });
    first.unmount();
    localStorage.clear();

    const again = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', WITH_CJK));
    await waitFor(() => expect(again.result.current.hostFont.glyphs.status).toBe('ready'));
    expect(wire.cuts.length).toBe(1);
    expect(glyphs.length).toBe(2);
  });

  it('a device with the CJK family installed is not asked', async () => {
    const wire = cuttingAdapter();
    const { deps } = glyphDeps([FONT.family, 'Noto Sans CJK SC']);
    const { result } = renderHook(() => useHostFont(wire.adapter, deps));
    act(() => wire.emit('terminalFont', WITH_CJK));
    await waitFor(() => expect(result.current.hostFont.glyphs.status).toBe('installed'));
    expect(wire.cuts).toEqual([]);
  });

  it('the cut CJK family sits after the Latin ones and before this device’s own', () => {
    const stack = resolveTerminalFontFamily('host', {
      family: 'JetBrainsMono Nerd Font',
      glyphs: { family: 'Noto Sans CJK SC', scope: 'cjk', alias: 'Herdr Glyphs cccccccccccc' },
    });
    expect(
      stack.startsWith(
        '"JetBrainsMono Nerd Font", "Herdr JetBrains Mono", "Herdr Glyphs cccccccccccc", "Noto Sans CJK SC", ui-monospace',
      ),
    ).toBe(true);
    const whole = resolveTerminalFontFamily('host', {
      family: 'Sarasa Mono SC',
      glyphs: { family: 'Sarasa Mono SC', scope: 'all', alias: 'Herdr Glyphs dddddddddddd' },
    });
    expect(whole.startsWith('"Herdr Glyphs dddddddddddd", "Sarasa Mono SC", ui-monospace')).toBe(
      true,
    );
  });
});
