import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../App';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { SettingsModal } from '../components/SettingsModal';
import { PairingModal } from '../components/PairingModal';
import { ToastContainer } from '../components/ToastContainer';
import { saveSettings } from '../utils/storage';
import * as themeModule from '../utils/theme';

describe('Herdr dark chrome with host-owned terminal colors', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = '';
  });

  it('keeps the app dark and removes the interface theme toggle', () => {
    saveSettings({ token: 'theme-test-token' });

    render(<App />);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(screen.queryByRole('button', { name: /Toggle color mode|Toggle theme/i })).not.toBeInTheDocument();
  });

  it('renders Toast notifications with dark surface and semantic status classes', () => {
    const ToastTrigger = () => {
      const { addToast } = useTerminal();
      return (
        <button
          onClick={() => addToast('success', 'Test Success Alert')}
          data-testid="trigger-toast"
        >
          Show Toast
        </button>
      );
    };

    render(
      <TerminalProvider>
        <ToastContainer />
        <ToastTrigger />
      </TerminalProvider>
    );

    act(() => {
      fireEvent.click(screen.getByTestId('trigger-toast'));
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.className).toContain('bg-paper');
    expect(alert.className).toContain('dark:bg-charcoal-900');
    expect(alert.className).toContain('border-emerald-300');
  });

  it('renders settings and pairing dialogs on the dark surface', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
        <PairingModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.length).toBe(2);

    for (const dialog of dialogs) {
      expect(dialog.querySelector('.bg-paper')).toBeTruthy();
    }
  });

  it('ships no client-side ANSI palette or contrast remapping at all', () => {
    // Every removed export is a color decision the client is no longer making.
    expect('TERMINAL_THEMES' in themeModule).toBe(false);
    expect('ANSI_COLOR_KEYS' in themeModule).toBe(false);
    expect('resolveTerminalTheme' in themeModule).toBe(false);
    expect('terminalMinimumContrastRatio' in themeModule).toBe(false);
    expect('contrastRatio' in themeModule).toBe(false);
  });

  it('never invents colors or contrast floors of its own', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../components/TerminalView.tsx'),
      'utf-8'
    );

    expect(source).not.toMatch(/minimumContrastRatio\s*[:=]/);
    // Not even the frame around the grid paints a color of its own.
    expect(source).not.toMatch(/backgroundColor/);
    // No literal color anywhere: the only palette is the one the host sent.
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('carries the host palette to xterm verbatim, and nothing when there is none', () => {
    expect(themeModule.hostPaletteToTheme(null)).toBeNull();
    expect(themeModule.hostPaletteToTheme(undefined)).toBeNull();
    expect(themeModule.hostPaletteToTheme({})).toBeNull();

    const hostPalette = {
      background: '#222226',
      foreground: '#ffffff',
      cursor: '#ffffff',
      ansi: {
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
      },
    };

    const theme = themeModule.hostPaletteToTheme(hostPalette)!;
    expect(theme.background).toBe('#222226');
    expect(theme.foreground).toBe('#ffffff');
    expect(theme.cursor).toBe('#ffffff');
    // The cursor glyph is drawn in the canvas color, as on the host.
    expect(theme.cursorAccent).toBe('#222226');
    expect(theme.red).toBe('#cc0000');
    expect(theme.brightCyan).toBe('#34e2e2');

    // A host that only knows its background must not gain sixteen invented colors.
    const partial = themeModule.hostPaletteToTheme({ background: '#101014' })!;
    expect(partial.background).toBe('#101014');
    expect(partial.red).toBeUndefined();
  });
});
