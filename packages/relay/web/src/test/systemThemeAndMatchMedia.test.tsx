import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { SettingsModal } from '../components/SettingsModal';
import { applyDocumentTheme, HERDR_DARK_BACKGROUND } from '../utils/theme';
import { loadSettings, saveSettings, LOCAL_STORAGE_KEY, SESSION_STORAGE_KEY } from '../utils/storage';

describe('Dark-only Herdr chrome, host-owned terminal colors', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = '';
    document.body.className = '';
  });

  it('applies the dark shell without ever consulting the operating-system theme', () => {
    const matchMedia = window.matchMedia;
    let queried = false;
    window.matchMedia = (() => {
      queried = true;
      throw new Error('dark-only appearance must not query matchMedia');
    }) as typeof window.matchMedia;

    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    applyDocumentTheme();

    expect(queried).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('light')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    // Catppuccin Mocha `crust` (#11111b) — the base Herdr's own TUI paints on.
    expect(document.body.style.backgroundColor).toBe('rgb(17, 17, 27)');
    expect(meta.getAttribute('content')).toBe(HERDR_DARK_BACKGROUND);

    meta.remove();
    window.matchMedia = matchMedia;
  });

  it('drops legacy theme / colorMode values from storage instead of honoring them', () => {
    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ theme: 'claude', colorMode: 'light', fontSize: 17 })
    );

    const settings = loadSettings();
    expect(settings.fontSize).toBe(17);
    expect('theme' in settings).toBe(false);
    expect('colorMode' in settings).toBe(false);

    const stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || '{}');
    expect(stored.theme).toBeUndefined();
    expect(stored.colorMode).toBeUndefined();
    expect(stored.fontSize).toBe(17);
  });

  it('drops legacy theme / colorMode from localStorage and never writes them back', () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ token: 'legacy-token', theme: 'matrix', colorMode: 'light' })
    );

    const settings = loadSettings();
    expect(settings.token).toBe('legacy-token');
    expect('theme' in settings).toBe(false);
    expect('colorMode' in settings).toBe(false);

    const storedAfterLoad = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
    expect(storedAfterLoad.theme).toBeUndefined();
    expect(storedAfterLoad.colorMode).toBeUndefined();

    saveSettings({ fontSize: 16 });
    const storedAfterSave = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
    expect(storedAfterSave.theme).toBeUndefined();
    expect(storedAfterSave.colorMode).toBeUndefined();
    expect(storedAfterSave.token).toBe('legacy-token');
  });

  it('exposes no appearance or palette controls in settings', () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.queryByText(/^Light$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^System$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Appearance Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Terminal Palette/i)).not.toBeInTheDocument();
  });
});
