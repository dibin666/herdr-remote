import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { RoleControlBadge } from '@/features/status/RoleControlBadge';
import { SettingsModal } from './SettingsModal';
import { getDefaultSettings, loadSettings } from './storage';
import {
  DEFAULT_TERMINAL_FONT,
  LEGACY_DEFAULT_FONT,
  PREVIOUS_DEFAULT_FONT,
} from '@/features/terminal/theme';
import {
  FONT_PRESETS,
  SYSTEM_FONT_STACK,
  resolveTerminalFontFamily,
} from '@/features/terminal/theme';

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

  it('follows the workstation terminal, face and size, by default', () => {
    const defaults = getDefaultSettings();
    expect(defaults.fontFamily).toBe('host');
    expect(DEFAULT_TERMINAL_FONT).toBe('host');
    expect(defaults.fontSizeFollowsHost).toBe(true);
    // Before the host has said anything, "host" draws with the system stack.
    expect(resolveTerminalFontFamily('host', null)).toBe(SYSTEM_FONT_STACK);
    expect(SYSTEM_FONT_STACK).toContain('ui-monospace');
    expect(SYSTEM_FONT_STACK).toContain('Consolas');
  });

  it('turns the stacks older builds stored into the presets that replaced them', () => {
    const cases: Array<[string, string]> = [
      [PREVIOUS_DEFAULT_FONT, 'host'],
      ['SFMono-Regular, Menlo, Monaco, "Symbols Nerd Font Mono", monospace', 'system'],
      ['Consolas, "Lucida Console", "Symbols Nerd Font Mono", monospace', 'system'],
      ['"Fira Code", "Symbols Nerd Font Mono", monospace', 'fira-code'],
    ];
    for (const [stored, expected] of cases) {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('herdr_remote_settings_v1', JSON.stringify({ fontFamily: stored }));
      expect(loadSettings().fontFamily).toBe(expected);
      expect(JSON.parse(localStorage.getItem('herdr_remote_settings_v1') || '{}').fontFamily).toBe(
        expected,
      );
    }
  });

  it('keeps a size somebody chose, and lets a default size follow the host', () => {
    localStorage.setItem('herdr_remote_settings_v1', JSON.stringify({ fontSize: 18 }));
    expect(loadSettings().fontSizeFollowsHost).toBe(false);
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('herdr_remote_settings_v1', JSON.stringify({ fontSize: 15 }));
    expect(loadSettings().fontSizeFollowsHost).toBe(true);
  });

  it('automatically migrates legacy default font in localStorage to the host font', () => {
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

    // When loading settings, it should auto-migrate to the host font
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

  it('offers the host font, the system stack and the bundled programming fonts in one dropdown', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );

    expect(screen.getByText(/Terminal Preferences/i)).toBeInTheDocument();

    const fontSelect = screen.getByLabelText(/Monospace Font/i) as HTMLSelectElement;
    expect(fontSelect.tagName).toBe('SELECT');
    expect(fontSelect.value).toBe('host');

    // Every preset is reachable from the one control
    const optionValues = Array.from(fontSelect.options).map((option) => option.value);
    expect(optionValues).toEqual(FONT_PRESETS.map((preset) => preset.id));
    expect(optionValues).toEqual(
      expect.arrayContaining([
        'jetbrains-mono',
        'fira-code',
        'cascadia-code',
        'source-code-pro',
        'ibm-plex-mono',
      ]),
    );

    fireEvent.change(fontSelect, { target: { value: 'cascadia-code' } });
    expect(loadSettings().fontFamily).toBe('cascadia-code');
  });

  it('SettingsModal says the text size belongs to this window alone', () => {
    let terminalCtx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <TestControlHelper
          onReady={(ctx) => {
            terminalCtx = ctx;
          }}
        />
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );

    // Every window has its own Herdr view and its own PTY, so the size set
    // here is this window's and nobody else's.
    expect(screen.getByText('This window only')).toBeInTheDocument();
    expect(screen.queryByText(/view isolation/i)).not.toBeInTheDocument();

    // Nothing a host says about its own build may put the old copy back.
    const withFeatures = { type: 'session_ready', features: { independentView: true } };
    act(() => {
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('sessionReady', withFeatures);
    });
    expect(screen.queryByText(/view isolation/i)).not.toBeInTheDocument();
  });

  it('offers no color controls at all, because colors belong to the host', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );

    expect(screen.queryByText(/Terminal Palette/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pure White/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Ivory/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Matrix Green/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Cursor Style$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Blinking Cursor$/i)).not.toBeInTheDocument();
  });

  it('RoleControlBadge states shared control and how many windows are attached', () => {
    // The lease is gone: every paired window types into the same terminal, so
    // the badge reports the shape of the room rather than offering a control
    // to seize it from somebody else.
    let terminalCtx: ReturnType<typeof useTerminal> | undefined;

    render(
      <TerminalProvider>
        <TestControlHelper
          onReady={(ctx) => {
            terminalCtx = ctx;
          }}
        />
        <RoleControlBadge />
      </TerminalProvider>,
    );

    act(() => {
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('stateChange', 'connected');
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('ready', {
        type: 'ready',
        role: 'controller',
        controllerId: 'client-local-11',
        hostId: 'host-1',
        clientId: 'client-local-11',
      });
      // @ts-expect-error test mock
      terminalCtx?.adapter?.emit('peerCount', 2);
    });

    expect(screen.getByText(/Full control/i)).toBeInTheDocument();
    expect(screen.getByText(/2 windows/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Takeover|Claim Control|Release/i })).toBeNull();
    expect(screen.queryByText(/Confirm Control Takeover/i)).toBeNull();
  });

  it('allows switching predictive echo mode via SettingsModal radio group and resets to default', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );

    const autoRadio = screen.getByRole('radio', { name: /Auto/i }) as HTMLInputElement;
    const alwaysRadio = screen.getByRole('radio', { name: /Always On/i }) as HTMLInputElement;
    const offRadio = screen.getByRole('radio', { name: /Off/i }) as HTMLInputElement;

    expect(autoRadio.checked).toBe(true);
    expect(alwaysRadio.checked).toBe(false);
    expect(offRadio.checked).toBe(false);

    fireEvent.click(offRadio);
    expect(loadSettings().predictiveEcho).toBe('off');

    fireEvent.click(alwaysRadio);
    expect(loadSettings().predictiveEcho).toBe('always');

    const resetButton = screen.getByRole('button', { name: /Reset to Defaults/i });
    fireEvent.click(resetButton);
    expect(loadSettings().predictiveEcho).toBe('auto');
  });

  describe('resolveTerminalFontFamily & Symbols Nerd Font Fallback', () => {
    it('includes Symbols Nerd Font Mono by default in the system monospace stack', () => {
      const resolved = resolveTerminalFontFamily(undefined);
      expect(resolved).toContain('Symbols Nerd Font Mono');
      expect(resolved).toContain('ui-monospace');
      expect(resolved).toContain('monospace');
    });

    it('puts the host font first: fetched files, then its name, then the bundled look-alike', () => {
      const resolved = resolveTerminalFontFamily('host', {
        family: 'JetBrainsMono Nerd Font',
        alias: 'Herdr Host 0ec29a68b539',
      });
      expect(
        resolved.startsWith(
          '"Herdr Host 0ec29a68b539", "JetBrainsMono Nerd Font", "Herdr JetBrains Mono", ui-monospace',
        ),
      ).toBe(true);
      expect(
        resolved.endsWith(
          '"Symbols Nerd Font Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Noto Sans Mono CJK TC", "Microsoft YaHei Mono", "PingFang SC", monospace',
        ),
      ).toBe(true);
      // Not loaded, and no bundled equivalent: the name, then the system stack.
      expect(
        resolveTerminalFontFamily('host', { family: 'Iosevka Term' }).startsWith(
          '"Iosevka Term", ui-monospace',
        ),
      ).toBe(true);
    });

    it('names an installed copy of a programming font ahead of the bundled one', () => {
      expect(
        resolveTerminalFontFamily('fira-code').startsWith(
          '"Fira Code", "Herdr Fira Code", ui-monospace',
        ),
      ).toBe(true);
      expect(resolveTerminalFontFamily('system')).toBe(SYSTEM_FONT_STACK);
    });

    it('injects Symbols Nerd Font Mono before monospace for custom user fonts', () => {
      const resolved = resolveTerminalFontFamily('"Fira Code", monospace');
      expect(resolved).toBe('"Fira Code", "Symbols Nerd Font Mono", monospace');
    });

    it('leaves fonts that already specify Symbols Nerd Font untouched', () => {
      const custom = 'MyFont, "Symbols Nerd Font Mono", monospace';
      expect(resolveTerminalFontFamily(custom)).toBe(custom);
    });

    it('handles bare monospace or fonts without monospace fallback safely', () => {
      expect(resolveTerminalFontFamily('monospace')).toBe('"Symbols Nerd Font Mono", monospace');
      expect(resolveTerminalFontFamily('Consolas')).toBe(
        'Consolas, "Symbols Nerd Font Mono", monospace',
      );
    });
  });
});
