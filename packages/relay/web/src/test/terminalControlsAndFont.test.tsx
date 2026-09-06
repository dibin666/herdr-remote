import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { RoleControlBadge } from '../components/RoleControlBadge';
import { SettingsModal } from '../components/SettingsModal';
import {
  DEFAULT_TERMINAL_FONT,
  LEGACY_DEFAULT_FONT,
  getDefaultSettings,
  loadSettings,
} from '../utils/storage';
import { FONT_PRESETS } from '../utils/theme';

// Helper component to control terminal context from within tests
const TestControlHelper: React.FC<{
  onReady?: (ctx: ReturnType<typeof useTerminal>) => void;
}> = ({ onReady }) => {
  const ctx = useTerminal();
  onReady?.(ctx);
  return null;
};

describe('Role Control, Takeover, and Terminal Typography', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses system default monospace font stack by default and matches presets', () => {
    const defaults = getDefaultSettings();
    expect(defaults.fontFamily).toBe(DEFAULT_TERMINAL_FONT);
    expect(defaults.fontFamily).toContain('ui-monospace');
    expect(defaults.fontFamily).toContain('Menlo');
    expect(defaults.fontFamily).toContain('Consolas');
    expect(defaults.fontFamily).toContain('monospace');
  });

  it('automatically migrates legacy default font in localStorage to the new system font stack', () => {
    // Simulate user having existing localStorage with legacy default font
    const legacyPayload = {
      wsUrl: '/ws/client',
      token: 'tok-123',
      clientId: 'client-abc',
      fontFamily: LEGACY_DEFAULT_FONT,
      fontSize: 15,
      theme: 'claude',
      colorMode: 'light',
    };
    localStorage.setItem('herdr_remote_settings_v1', JSON.stringify(legacyPayload));

    // When loading settings, it should auto-migrate to DEFAULT_TERMINAL_FONT
    const loaded = loadSettings();
    expect(loaded.fontFamily).toBe(DEFAULT_TERMINAL_FONT);
    expect(loaded.token).toBe('tok-123');
    expect(loaded.clientId).toBe('client-abc');

    // And verify that the updated setting is persisted back into localStorage
    const rawStored = JSON.parse(localStorage.getItem('herdr_remote_settings_v1') || '{}');
    expect(rawStored.fontFamily).toBe(DEFAULT_TERMINAL_FONT);
  });

  it('preserves user custom font and does not overwrite it during migration check', () => {
    const customUserFont = '"Fira Code", monospace';
    const customPayload = {
      wsUrl: '/ws/client',
      token: 'tok-456',
      clientId: 'client-custom',
      fontFamily: customUserFont,
      fontSize: 16,
    };
    localStorage.setItem('herdr_remote_settings_v1', JSON.stringify(customPayload));

    const loaded = loadSettings();
    expect(loaded.fontFamily).toBe(customUserFont);
    expect(loaded.fontSize).toBe(16);
  });

  it('offers the monospace font stacks as a single dropdown', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.getByText(/Terminal Preferences/i)).toBeInTheDocument();

    const fontSelect = screen.getByLabelText(/Terminal Monospace Font/i) as HTMLSelectElement;
    expect(fontSelect.tagName).toBe('SELECT');
    expect(fontSelect.value).toBe(DEFAULT_TERMINAL_FONT);

    // Every preset is reachable from the one control
    const optionValues = Array.from(fontSelect.options).map((option) => option.value);
    for (const preset of FONT_PRESETS) {
      expect(optionValues).toContain(preset.font);
    }

    fireEvent.change(fontSelect, { target: { value: FONT_PRESETS[1].font } });
    expect(loadSettings().fontFamily).toBe(FONT_PRESETS[1].font);
  });

  it('SettingsModal states plainly that every client shares one Herdr view', () => {
    let terminalCtx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <TestControlHelper onReady={(ctx) => { terminalCtx = ctx; }} />
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.getByText(/standard Herdr server/i)).toBeInTheDocument();

    // There is no per-device view any more, so nothing a host says about its
    // own build may put that copy back.
    act(() => {
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('sessionReady', {
        type: 'session_ready',
        features: { independentView: true },
      });
    });
    expect(screen.getByText(/standard Herdr server/i)).toBeInTheDocument();
  });

  it('offers no color controls at all, because colors belong to the host', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.queryByText(/Terminal Palette/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pure White/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Ivory/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Matrix Green/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Cursor Style$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Blinking Cursor$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pass through from the host/i)).toBeInTheDocument();
  });

  it('RoleControlBadge prompts confirmation dialog for Takeover when another device is controlling', async () => {
    // Render RoleControlBadge inside TerminalProvider
    let terminalCtx: ReturnType<typeof useTerminal> | undefined;

    render(
      <TerminalProvider>
        <TestControlHelper onReady={(ctx) => { terminalCtx = ctx; }} />
        <RoleControlBadge />
      </TerminalProvider>
    );

    // Simulate adapter connection and receiving a ready message where another client is controller
    act(() => {
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('stateChange', 'connected');
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('ready', {
        type: 'ready',
        role: 'viewer',
        controllerId: 'client-other-99',
        hostId: 'host-1',
        clientId: 'client-local-11',
      });
    });

    // Badge should show viewer with active controller ID
    expect(screen.getByText(/Viewer \(Active: client-other-99\)/i)).toBeInTheDocument();

    // Takeover button should be present
    const takeoverBtn = screen.getByRole('button', { name: /Takeover terminal control/i });
    expect(takeoverBtn).toBeInTheDocument();

    // Spy on claimControl
    const claimControlSpy = vi.spyOn(terminalCtx!.adapter!, 'claimControl');

    // Click takeover button - should show confirmation modal, NOT immediately force claim
    fireEvent.click(takeoverBtn);

    expect(screen.getByText(/Confirm Control Takeover/i)).toBeInTheDocument();
    expect(screen.getAllByText(/client-other-99/i).length).toBeGreaterThanOrEqual(1);
    expect(claimControlSpy).not.toHaveBeenCalled();

    // Confirm takeover in modal
    const confirmBtn = screen.getByRole('button', { name: /Confirm Takeover/i });
    fireEvent.click(confirmBtn);

    expect(claimControlSpy).toHaveBeenCalledWith(true);
  });
});
