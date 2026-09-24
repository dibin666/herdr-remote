import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ID_ALIASES,
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  GENERIC_SHELL_ACTIONS,
  HERDR_AGENT_IDS,
  applyOverrides,
  clearBarVisibility,
  filterDuplicateGenericActions,
  getDrawerGroups,
  getProfileActions,
  resolveProfile,
  type AgentProfileDef,
} from '../utils/agentKeymaps';
import { LOCAL_STORAGE_KEY, loadSettings, saveSettings } from '../utils/storage';

describe('Herdr agent keymaps', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('resolves all 24 canonical Herdr agent IDs', () => {
    expect(HERDR_AGENT_IDS).toHaveLength(24);
    for (const id of HERDR_AGENT_IDS) {
      expect(resolveProfile(id, 'auto'), id).toBe(id);
    }
  });

  it('resolves every detector alias to its canonical profile', () => {
    for (const [alias, profile] of Object.entries(AGENT_ID_ALIASES)) {
      expect(resolveProfile(alias, 'auto'), alias).toBe(profile);
    }
    expect(resolveProfile('/opt/bin/muse-bin-0.1.0-R708.1', 'auto')).toBe('muse');
  });

  it('uses automatic focus unless this window pins a profile', () => {
    expect(resolveProfile('claude-code', 'auto')).toBe('claude');
    expect(resolveProfile('pi', 'codex')).toBe('codex');
    expect(resolveProfile('claude', 'shell')).toBe('shell');
    expect(resolveProfile(null, 'auto')).toBe('shell');
    expect(resolveProfile('unrecognized-agent', 'auto')).toBe('shell');
  });

  it('merges reordered, rebound, hidden and custom actions without changing defaults', () => {
    const defaults = AGENT_PROFILES.claude.actions.slice(0, 2);
    const merged = applyOverrides(defaults, {
      order: ['custom-1', defaults[1].id, defaults[0].id],
      actions: {
        [defaults[0].id]: { keys: 'ctrl+e' },
        [defaults[1].id]: { hidden: true },
      },
      custom: [{ id: 'custom-1', label: 'Run test', keys: 'alt+enter' }],
    });

    expect(merged.map((item) => item.id)).toEqual(['custom-1', defaults[1].id, defaults[0].id]);
    expect(merged[0]).toMatchObject({ custom: true, customLabel: 'Run test', combo: 'alt+enter' });
    expect(merged[1].hidden).toBe(true);
    expect(merged[2]).toMatchObject({ defaultCombo: 'shift+tab', combo: 'ctrl+e' });
    expect(defaults[0].combo).toBe('shift+tab');
  });

  it('keeps every profile to a few common shortcuts by default', () => {
    for (const id of AGENT_PROFILE_IDS) {
      const profile: AgentProfileDef = AGENT_PROFILES[id];
      const actionIds = profile.actions.map((item) => item.id);
      for (const barId of profile.bar || []) expect(actionIds, `${id}:${barId}`).toContain(barId);

      const groups = getDrawerGroups(id);
      expect(groups.agentActions.length, id).toBeLessThanOrEqual(4);
      expect(groups.agentActions.length + groups.genericActions.length, id).toBeLessThanOrEqual(5);
    }

    expect(getDrawerGroups('claude').genericActions.map((item) => item.id)).toEqual(['genericCtrlC']);
    expect(getDrawerGroups('shell').genericActions.map((item) => item.id))
      .toEqual(['genericCtrlC', 'genericCtrlD', 'genericCtrlL', 'genericCtrlR']);
  });

  it('lets a saved choice override the default visibility either way', () => {
    const rows = getProfileActions('claude', {
      actions: { stash: { hidden: false }, mode: { hidden: true } },
    });
    expect(rows.find((item) => item.id === 'stash')?.hidden).toBe(false);
    expect(rows.find((item) => item.id === 'mode')?.hidden).toBe(true);
    expect(rows.find((item) => item.id === 'todos')?.hidden).toBe(true);
    expect(rows.find((item) => item.id === 'rewind')?.hidden).toBe(false);
  });

  it('drops a generic chord when the agent group already exposes that combo', () => {
    const groups = getDrawerGroups('hermes', { actions: { genericCtrlD: { hidden: false } } });
    expect(groups.agentActions.some((item) => item.combo === 'ctrl+c')).toBe(true);
    expect(groups.genericActions.some((item) => item.combo === 'ctrl+c')).toBe(false);
    expect(groups.genericActions.some((item) => item.combo === 'ctrl+d')).toBe(true);

    const customOverlap = applyOverrides(GENERIC_SHELL_ACTIONS, {
      actions: { genericCtrlD: { keys: 'ctrl+c' } },
    });
    const deduplicated = filterDuplicateGenericActions(groups.agentActions, customOverlap);
    expect(deduplicated.some((item) => item.id === 'genericCtrlD')).toBe(false);

    // Hiding the agent's own ^C hides ^C; the shell's ^C does not step in.
    const hidden = getDrawerGroups('hermes', { actions: { interrupt: { hidden: true } } });
    expect([...hidden.agentActions, ...hidden.genericActions].some((item) => item.combo === 'ctrl+c')).toBe(false);
  });

  it('restores default visibility without dropping rebinds', () => {
    expect(clearBarVisibility({
      order: ['model', 'mode'],
      actions: { mode: { hidden: true }, details: { keys: 'ctrl+e', hidden: false } },
    })).toEqual({ order: ['model', 'mode'], actions: { details: { keys: 'ctrl+e' } } });
  });

  it('stores sanitized keymaps globally so a new window inherits the rebind', () => {
    saveSettings({
      agentKeymaps: {
        claude: {
          actions: { details: { keys: 'ctrl+e' } },
          custom: [{ id: 'custom-1', label: 'Run', keys: 'alt+enter' }],
        },
      },
    });
    const global = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
    expect(global.agentKeymaps.claude.actions.details.keys).toBe('ctrl+e');
    expect(JSON.parse(sessionStorage.getItem('herdr_remote_session_view_v1') || '{}').agentKeymaps).toBeUndefined();

    sessionStorage.clear();
    expect(loadSettings().agentKeymaps.claude.custom?.[0]).toEqual({
      id: 'custom-1', label: 'Run', keys: 'alt+enter',
    });
  });

  it('drops malformed keymap values and bounds saved labels and combos', () => {
    saveSettings({ agentKeymaps: {
      claude: {
        actions: {
          details: { keys: `ctrl+e${'x'.repeat(90)}`, hidden: true },
          invalid: { keys: '', hidden: 'yes' as unknown as boolean },
        },
        custom: [
          { id: 'too-long', label: 'L'.repeat(100), keys: `alt+enter${'x'.repeat(90)}` },
          { id: 'too-long', label: 'Duplicate', keys: 'ctrl+x' },
          { id: '__proto__', label: 'Bad ID', keys: 'ctrl+x' },
        ],
      },
      '__proto__': { actions: { details: { keys: 'ctrl+x' } }, custom: [] },
    } });

    const settings = loadSettings();
    expect(settings.agentKeymaps.claude.actions?.details?.keys).toBeUndefined();
    expect(settings.agentKeymaps.claude.actions?.details?.hidden).toBe(true);
    expect(settings.agentKeymaps.claude.actions?.invalid).toBeUndefined();
    expect(settings.agentKeymaps.claude.custom).toEqual([{
      id: 'too-long', label: 'Duplicate', keys: 'ctrl+x',
    }]);
    expect(settings.agentKeymaps['__proto__']).toBeUndefined();
  });
});
