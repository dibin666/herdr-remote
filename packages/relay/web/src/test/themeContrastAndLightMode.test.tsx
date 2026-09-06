import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../App';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { SettingsModal } from '../components/SettingsModal';
import { PairingModal } from '../components/PairingModal';
import { ToastContainer } from '../components/ToastContainer';
import { saveSettings } from '../utils/storage';
import { ANSI_COLOR_KEYS, contrastRatio, TERMINAL_THEMES, terminalMinimumContrastRatio } from '../utils/theme';

describe('Herdr dark theme contrast', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = '';
  });

  it('keeps the app dark and removes the interface theme toggle', () => {
    saveSettings({ colorMode: 'light', token: 'theme-test-token' });

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

  it('defines a complete readable ANSI palette for every built-in theme', () => {
    for (const [name, theme] of Object.entries(TERMINAL_THEMES)) {
      for (const key of ANSI_COLOR_KEYS) {
        const color = theme[key];
        expect(color, `${name}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }

      if (name === 'claude' || name === 'light') {
        for (const key of ANSI_COLOR_KEYS.slice(0, 8)) {
          expect(contrastRatio(theme[key]!, theme.background!), `${name}.${key}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const key of ANSI_COLOR_KEYS.slice(8)) {
          expect(contrastRatio(theme[key]!, theme.background!), `${name}.${key}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('uses xterm contrast protection only for light terminal palettes', () => {
    expect(terminalMinimumContrastRatio('claude')).toBe(3);
    expect(terminalMinimumContrastRatio('light')).toBe(3);
    expect(terminalMinimumContrastRatio('dark')).toBe(1);
    expect(terminalMinimumContrastRatio('tokyonight')).toBe(1);
  });
});
