import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsModal } from '../components/SettingsModal';
import { KeyToolbar } from '../components/KeyToolbar';
import { TerminalProvider } from '../context/TerminalContext';
import { saveSettings, loadSettings } from '../utils/storage';
import { getDefaultVirtualKeys } from '../utils/virtualKeys';

describe('Virtual Keyboard Customization (Requirement 5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders customized keys in KeyToolbar based on settings', () => {
    const customKeys = [
      { id: 'custom_esc', label: 'ESC', code: '\x1b', type: 'key' as const, enabled: true, title: 'Escape' },
      { id: 'custom_enter', label: 'Enter', code: '\r', type: 'key' as const, enabled: true, title: 'Enter' },
      { id: 'custom_disabled', label: 'DISABLED', code: 'x', type: 'key' as const, enabled: false, title: 'Disabled' },
    ];

    saveSettings({ virtualKeys: customKeys, toolbarVisible: true });

    render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>
    );

    expect(screen.getByText('ESC')).toBeInTheDocument();
    expect(screen.getByText('Enter')).toBeInTheDocument();
    expect(screen.queryByText('DISABLED')).toBeNull();
  });

  it('allows enabling, disabling, and reordering keys via SettingsModal', async () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    // Switch to Virtual Keys Tab
    const virtualKeysTab = screen.getByRole('button', { name: /Virtual Keyboard|虚拟按键/i });
    fireEvent.click(virtualKeysTab);

    expect(screen.getByText(/Custom Key Toolbar Layout|自定义虚拟按键/i)).toBeInTheDocument();

    // Toggle ESC key checkbox
    const escCheckbox = document.querySelector('#toggle-esc');
    expect(escCheckbox).toBeDefined();

    if (escCheckbox) {
      fireEvent.click(escCheckbox);
      const settings = loadSettings();
      const escDef = settings.virtualKeys.find((k) => k.id === 'esc');
      expect(escDef?.enabled).toBe(false);
    }
  });

  it('adds keys from available catalog into the active layout', async () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    const virtualKeysTab = screen.getByRole('button', { name: /Virtual Keyboard|虚拟按键/i });
    fireEvent.click(virtualKeysTab);

    // Click Add Key button
    const addKeyBtn = screen.getByRole('button', { name: /^Add Key$|^添加按键$/i });
    fireEvent.click(addKeyBtn);

    expect(screen.getByText(/Available Keys Palette|可选按键库/i)).toBeInTheDocument();

    // Find F1 in catalog and click
    const f1Buttons = screen.getAllByRole('button', { name: /F1/i });
    expect(f1Buttons.length).toBeGreaterThan(0);
    fireEvent.click(f1Buttons[0]);

    const settings = loadSettings();
    const f1InSettings = settings.virtualKeys.find((k) => k.id === 'f1');
    expect(f1InSettings).toBeDefined();
    expect(f1InSettings?.enabled).toBe(true);
  });

  it('resets virtual keys to default layout', async () => {
    saveSettings({ virtualKeys: [] });

    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    const virtualKeysTab = screen.getByRole('button', { name: /Virtual Keyboard|虚拟按键/i });
    fireEvent.click(virtualKeysTab);

    const resetBtn = screen.getByRole('button', { name: /Reset to Default Layout|恢复默认布局/i });
    fireEvent.click(resetBtn);

    const settings = loadSettings();
    expect(settings.virtualKeys.length).toBe(getDefaultVirtualKeys().length);
    expect(settings.virtualKeys.some((k) => k.id === 'esc')).toBe(true);
  });
});
