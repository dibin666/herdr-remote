import { describe, it, expect } from 'vitest';
import {
  type ConnectionProfile,
  createConnectionProfile,
} from '@/features/pairing/connectionProfiles';
import { DEFAULT_DESKTOP_FONT_SIZE } from '@/features/terminal/terminalLayout';
import { STORAGE_KEYS } from '@/shared/lib/browserStorage';
import { simulateWindows } from '@/test/helpers/windowStorage';
import { loadSettings, saveSettings } from './storage';

const office = createConnectionProfile({
  id: 'profile-office',
  displayName: 'Office',
  wsUrl: '/ws/client',
  token: 'office-device-token-123456',
  hostId: 'host-office',
});
const home = createConnectionProfile({
  id: 'profile-home',
  displayName: 'Home',
  wsUrl: '/ws/client',
  token: 'home-device-token-123456',
  hostId: 'host-home',
});

function pairBoth() {
  saveSettings({
    profiles: [office, home],
    activeProfileId: office.id,
    wsUrl: office.wsUrl,
    token: office.token,
  });
}

/** What `switchProfile` saves. */
function switchTo(profile: ConnectionProfile) {
  saveSettings({
    activeProfileId: profile.id,
    wsUrl: profile.wsUrl,
    token: profile.token,
    pairCode: '',
    autoReconnect: profile.autoReconnect,
  });
}

describe('Settings of each Herdr instance', () => {
  it('keeps font, input, alerts and agent keys to the instance they were set on', () => {
    simulateWindows(1);
    pairBoth();
    saveSettings({
      fontSize: 22,
      predictiveEcho: 'off',
      agentAlertSound: true,
      agentKeymaps: { claude: { actions: { details: { keys: 'ctrl+e' } } } },
    });

    switchTo(home);
    let settings = loadSettings();
    expect(settings.activeProfileId).toBe(home.id);
    expect(settings.fontSize).toBe(DEFAULT_DESKTOP_FONT_SIZE);
    expect(settings.predictiveEcho).toBe('auto');
    expect(settings.agentAlertSound).toBe(false);
    expect(settings.agentKeymaps).toEqual({});
    saveSettings({ fontSize: 12 });

    switchTo(office);
    settings = loadSettings();
    expect(settings.fontSize).toBe(22);
    expect(settings.predictiveEcho).toBe('off');
    expect(settings.agentAlertSound).toBe(true);
    expect(settings.agentKeymaps.claude.actions?.details.keys).toBe('ctrl+e');

    switchTo(home);
    expect(loadSettings().fontSize).toBe(12);
  });

  it('keeps the interface language the same for every instance', () => {
    simulateWindows(1);
    pairBoth();
    saveSettings({ language: 'zh' });
    switchTo(home);
    expect(loadSettings().language).toBe('zh');
  });

  it('leaves a window on its own instance when another window switches', () => {
    const windows = simulateWindows(3);
    pairBoth();
    windows.use(1);
    expect(loadSettings().activeProfileId).toBe(office.id);

    windows.use(0);
    switchTo(home);

    // Changing a setting used to re-read the instance another window had just
    // picked, which moved this window's connection and settings over to it.
    windows.use(1);
    const settings = saveSettings({ fontSize: 18 });
    expect(settings.activeProfileId).toBe(office.id);
    expect(settings.token).toBe(office.token);
    windows.use(0);
    expect(loadSettings().fontSize).toBe(DEFAULT_DESKTOP_FONT_SIZE);

    // A new window opens where a window last moved to.
    windows.use(2);
    expect(loadSettings().activeProfileId).toBe(home.id);
  });

  it('starts a reopened window from the settings its instance last had', () => {
    const windows = simulateWindows(1);
    pairBoth();
    saveSettings({ fontSize: 20, toolbarPosition: 'top' });
    switchTo(home);
    saveSettings({ fontSize: 11 });
    switchTo(office);

    windows.reopen(0);
    expect(loadSettings()).toMatchObject({ fontSize: 20, toolbarPosition: 'top' });
    switchTo(home);
    expect(loadSettings()).toMatchObject({ fontSize: 11, toolbarPosition: 'bottom' });
  });

  it('forgets the settings of an instance that is removed', () => {
    const windows = simulateWindows(1);
    pairBoth();
    saveSettings({ fontSize: 22 });
    saveSettings({
      profiles: [home],
      activeProfileId: home.id,
      wsUrl: home.wsUrl,
      token: home.token,
    });

    const stored = JSON.parse(windows.local.getItem(STORAGE_KEYS.settings) || '{}');
    expect(Object.keys(stored.instances)).toEqual([home.id]);
    expect(loadSettings().fontSize).toBe(DEFAULT_DESKTOP_FONT_SIZE);
  });

  it('starts every instance from the settings saved before instances had their own', () => {
    const windows = simulateWindows(1);
    windows.local.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        profiles: [office, home],
        activeProfileId: office.id,
        fontSize: 19,
        toolbarPosition: 'top',
      }),
    );

    expect(loadSettings()).toMatchObject({ fontSize: 19, toolbarPosition: 'top' });
    switchTo(home);
    expect(loadSettings()).toMatchObject({ fontSize: 19, toolbarPosition: 'top' });
    saveSettings({ fontSize: 13 });
    switchTo(office);
    expect(loadSettings().fontSize).toBe(19);
  });

  it('gives what an unpaired window changed to its first instance', () => {
    simulateWindows(1);
    saveSettings({ fontSize: 21 });
    const paired = saveSettings({ wsUrl: '/ws/client', token: 'first-device-token-123456' });
    expect(paired.profiles).toHaveLength(1);
    expect(paired.fontSize).toBe(21);
  });
});
