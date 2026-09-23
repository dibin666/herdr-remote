import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KeyToolbar } from '../components/KeyToolbar';
import { Header } from '../components/Header';
import { TerminalProvider } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import { ALL_AVAILABLE_KEYS, DEFAULT_TOOLBAR_KEYS, sanitizeVirtualKeys } from '../utils/virtualKeys';

/**
 * Where the touch keys sit, and what language the chrome speaks.
 *
 * Both were reported as defects against the same row of the screen: Enter was
 * buried in the middle of the bar with a collapse control taking the right-hand
 * end, the Fn drawer's arrow pointed sideways at nothing, and the commands on
 * the header stayed English on a Chinese interface.
 */
describe('Touch key bar layout', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const renderToolbar = () => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    return render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>
    );
  };

  it('ends the default bar with Enter, where a keyboard puts it', () => {
    expect(DEFAULT_TOOLBAR_KEYS[DEFAULT_TOOLBAR_KEYS.length - 1].id).toBe('enter');
    expect(DEFAULT_TOOLBAR_KEYS.map((key) => key.id)).toEqual([
      'esc', 'tab', 'ctrl', 'alt', 'left', 'up', 'down', 'right',
      'drawer_agent', 'drawer_symbols', 'drawer_fn', 'enter',
    ]);
  });

  it('puts Enter at the right-hand end of the rendered row', () => {
    renderToolbar();

    const row = screen.getByTestId('key-toolbar-row');
    const buttons = within(row).getAllByRole('button');
    const last = buttons[buttons.length - 1];

    expect(last).toHaveAttribute('aria-label', expect.stringMatching(/enter/i));
    // ...and the way out is at the other end, not occupying the thumb's spot.
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/collapse/i));
  });

  it('points the Fn arrow at the drawer, which opens upwards', () => {
    renderToolbar();

    const fn = screen.getByRole('button', { name: /function keys/i });
    expect(fn.textContent).toContain('▴');

    fireEvent.click(fn);
    expect(screen.getByRole('button', { name: /function keys/i }).textContent).toContain('▾');
    expect(screen.getByRole('button', { name: 'F7' })).toBeInTheDocument();
  });

  it('upgrades an untouched saved layout to the new default order', () => {
    // The previous shipped default had a dedicated Shift+Tab and Ctrl drawer.
    const byId = new Map(ALL_AVAILABLE_KEYS.map((key) => [key.id, key]));
    const legacy = [
      'esc', 'tab', 'shift_tab', 'ctrl', 'alt', 'left', 'up', 'down', 'right',
      'drawer_chords', 'drawer_symbols', 'drawer_fn', 'enter',
    ].map((id) => byId.get(id)!);

    const upgraded = sanitizeVirtualKeys(legacy);
    expect(upgraded.map((key) => key.id)).toEqual(DEFAULT_TOOLBAR_KEYS.map((key) => key.id));

    const oldestLegacy = ['esc', 'tab', 'ctrl', 'alt', 'left', 'up', 'down', 'right', 'enter', 'drawer_chords', 'drawer_symbols', 'drawer_fn']
      .map((id) => byId.get(id)!);
    expect(sanitizeVirtualKeys(oldestLegacy).map((key) => key.id)).toEqual(DEFAULT_TOOLBAR_KEYS.map((key) => key.id));

    // A layout the user actually arranged is left exactly as they left it.
    const custom = [legacy[0], legacy[1]];
    expect(sanitizeVirtualKeys(custom).map((key) => key.id)).toEqual(custom.map((key) => key.id));
  });

  it('collapses to a handle that is named in the interface language', () => {
    saveSettings({ toolbarVisible: false, language: 'zh' });
    render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>
    );

    const handle = screen.getByTestId('key-toolbar-collapsed');
    expect(handle.textContent).toContain('按键条');
    expect(handle.textContent).not.toContain('keys');
  });
});

describe('Header commands', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const renderHeader = () =>
    render(
      <TerminalProvider>
        <Header
          currentView="terminal"
          onNavigate={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
          onToggleVirtualKeyboard={() => {}}
          isVirtualKeyboardOpen={false}
        />
      </TerminalProvider>
    );

  it('says what it does in Chinese when the interface is Chinese', () => {
    saveSettings({ language: 'zh' });
    renderHeader();

    expect(screen.getByRole('button', { name: '快捷命令' }).textContent).toBe('命令');
    expect(screen.getByRole('button', { name: '连接与配对' }).textContent).toBe('配对');
    expect(screen.getByRole('button', { name: '终端设置' }).textContent).toBe('设置');
  });

  it('keeps the terse English words on an English interface', () => {
    saveSettings({ language: 'en' });
    renderHeader();

    expect(screen.getByRole('button', { name: /quick command/i }).textContent).toBe('cmd');
    expect(screen.getByRole('button', { name: /connection & pairing/i }).textContent).toBe('link');
    expect(screen.getByRole('button', { name: /terminal settings/i }).textContent).toBe('cfg');
  });
});
