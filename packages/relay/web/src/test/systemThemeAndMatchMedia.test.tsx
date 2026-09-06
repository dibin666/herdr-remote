import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { SettingsModal } from '../components/SettingsModal';
import {
  resolveEffectiveColorMode,
  resolveTerminalTheme,
  applyDocumentTheme,
  HERDR_DARK_BACKGROUND,
  TERMINAL_THEMES,
} from '../utils/theme';
import { saveSettings, loadSettings, SESSION_STORAGE_KEY } from '../utils/storage';

describe('Dark-only Herdr appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = '';
    document.body.className = '';
  });

  it('always resolves dark without consulting the operating-system theme', () => {
    const matchMedia = window.matchMedia;
    let queried = false;
    window.matchMedia = (() => {
      queried = true;
      throw new Error('dark-only appearance must not query matchMedia');
    }) as typeof window.matchMedia;

    expect(resolveEffectiveColorMode('light')).toBe('dark');
    expect(resolveEffectiveColorMode('dark')).toBe('dark');
    expect(resolveEffectiveColorMode('system')).toBe('dark');
    expect(queried).toBe(false);

    window.matchMedia = matchMedia;
  });

  it('applies dark classes and the Herdr midnight background for every input mode', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    applyDocumentTheme('dark');
    applyDocumentTheme('light');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('light')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.body.style.backgroundColor).toBe('rgb(11, 17, 32)');
    expect(meta.getAttribute('content')).toBe(HERDR_DARK_BACKGROUND);

    meta.remove();
  });

  it('migrates legacy light/system storage to the dark-only defaults', () => {
    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ theme: 'claude', colorMode: 'light' })
    );

    const settings = loadSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.colorMode).toBe('dark');
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || '{}')).toMatchObject({
      theme: 'dark',
      colorMode: 'dark',
    });
  });

  it('uses the Herdr dark terminal palette by default', () => {
    const resolved = resolveTerminalTheme('dark', 'dark', 'dark');

    expect(resolved.resolvedThemeName).toBe('dark');
    expect(resolved.theme).toEqual(TERMINAL_THEMES.dark);
    expect(resolved.theme).not.toBe(TERMINAL_THEMES.dark);
    expect(resolved.background).toBe(HERDR_DARK_BACKGROUND);
    expect(resolved.theme.cursor).toBe('#7dd3fc');
  });

  it('keeps explicit terminal palettes available independently of shell appearance', () => {
    const legacyLightPalette = resolveTerminalTheme('claude', 'dark', 'dark');
    expect(legacyLightPalette.resolvedThemeName).toBe('claude');
    expect(legacyLightPalette.theme).toEqual(TERMINAL_THEMES.claude);

    const tokyoResolved = resolveTerminalTheme('tokyonight', 'dark', 'dark');
    expect(tokyoResolved.resolvedThemeName).toBe('tokyonight');
    expect(tokyoResolved.theme).toEqual(TERMINAL_THEMES.tokyonight);

    const lightResolved = resolveTerminalTheme('light', 'dark', 'dark');
    expect(lightResolved.resolvedThemeName).toBe('light');
    expect(lightResolved.theme).toEqual(TERMINAL_THEMES.light);
  });

  it('removes interface appearance controls and normalizes legacy settings to dark', () => {
    saveSettings({ colorMode: 'light', theme: 'claude' });

    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.queryByText(/^Light$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^System$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Appearance Mode/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Terminal Palette/i).length).toBeGreaterThan(0);
    expect(loadSettings().colorMode).toBe('dark');
  });
});
