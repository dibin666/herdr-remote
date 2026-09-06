import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import type { HostTerminalPalette } from '../types/protocol';
import type { MockTerminalInstance } from './setup';

/**
 * The web client makes no color decisions. A Herdr session looks the way the
 * workstation's terminal looks, because the host reports that terminal's own
 * colors and xterm is handed them verbatim.
 */

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;

const HOST_ANSI = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
};

let terminalCtx: ReturnType<typeof useTerminal> | undefined;

const CaptureContext: React.FC = () => {
  terminalCtx = useTerminal();
  return null;
};

const renderTerminal = () => {
  terminalCtx = undefined;
  return render(
    <TerminalProvider>
      <CaptureContext />
      <TerminalView isActive={true} />
    </TerminalProvider>
  );
};

const sendReady = (terminalPalette: HostTerminalPalette | null) =>
  act(() => {
    // @ts-expect-error emit is private; the relay drives it over the wire
    terminalCtx?.adapter?.emit('stateChange', 'connected');
    // @ts-expect-error emit is private; the relay drives it over the wire
    terminalCtx?.adapter?.emit('ready', {
      type: 'ready',
      role: 'viewer',
      hostId: 'host-1',
      clientId: 'client-1',
      terminalPalette,
    });
  });

describe('Host terminal palette pass-through', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
  });

  it('opens xterm with no theme of its own', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    // Nothing has told us what the host looks like yet, so xterm keeps its
    // built-in colors instead of a palette this client invented.
    expect(xtermInstances[0].options.theme).toBeUndefined();
    expect(xtermInstances[0].options.minimumContrastRatio).toBeUndefined();
  });

  it('repaints with the workstation palette the moment the host reports it', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    const refreshesBefore = term.refreshCount;

    sendReady({
      background: '#222226',
      foreground: '#ffffff',
      cursor: '#ffffff',
      ansi: HOST_ANSI,
    });

    await waitFor(() => {
      expect((term.options.theme as Record<string, string> | undefined)?.background).toBe('#222226');
    });

    const theme = term.options.theme as Record<string, string>;
    expect(theme.foreground).toBe('#ffffff');
    expect(theme.cursor).toBe('#ffffff');
    expect(theme.red).toBe('#cc0000');
    expect(theme.brightWhite).toBe('#eeeeec');
    expect(term.refreshCount).toBeGreaterThan(refreshesBefore);
    expect(terminalCtx?.hostPalette?.background).toBe('#222226');
  });

  it('leaves xterm alone when the host has no terminal to report', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    sendReady(null);

    await waitFor(() => expect(terminalCtx?.hostId).toBe('host-1'));
    expect(xtermInstances[0].options.theme).toBeUndefined();
    expect(terminalCtx?.hostPalette).toBeNull();
  });
});
