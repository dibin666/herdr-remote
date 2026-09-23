import { describe, expect, it } from 'vitest';
import { formatComboCaption, KeyComboError, parseKeyCombo } from '../protocol/keyCombo';
import { AGENT_PROFILES, GENERIC_SHELL_ACTIONS } from '../utils/agentKeymaps';

describe('agent key combo encoding', () => {
  it('parses every default combo in every Herdr profile', () => {
    const actions = [
      ...Object.values(AGENT_PROFILES).flatMap((profile) => profile.actions),
      ...GENERIC_SHELL_ACTIONS,
    ];
    for (const action of actions) {
      expect(parseKeyCombo(action.combo), `${action.id}: ${action.combo}`).not.toHaveLength(0);
    }
  });

  it('sends Esc Esc as two independent presses', () => {
    expect(parseKeyCombo('esc esc')).toEqual(['\x1b', '\x1b']);
  });

  it('keeps Ctrl+M and Ctrl+I distinct from Ctrl+Enter and Ctrl+Tab', () => {
    expect(parseKeyCombo('ctrl+m')).toEqual(['\x1b[109;5u']);
    expect(parseKeyCombo('ctrl+i')).toEqual(['\x1b[105;5u']);
    expect(parseKeyCombo('ctrl+enter')).toEqual(['\x1b[13;5u']);
    expect(parseKeyCombo('ctrl+tab')).toEqual(['\x1b[9;5u']);
  });

  it('encodes control punctuation without leaking the printable character', () => {
    expect(parseKeyCombo('ctrl+.')).toEqual(['\x1b[46;5u']);
    expect(parseKeyCombo('ctrl+-')).toEqual(['\x1f']);
    expect(parseKeyCombo('ctrl+/')).toEqual(['\x1f']);
    expect(parseKeyCombo('ctrl+_')).toEqual(['\x1f']);
    expect(parseKeyCombo('ctrl+backslash')).toEqual(['\x1c']);
    expect(parseKeyCombo('ctrl+]')).toEqual(['\x1d']);
    expect(parseKeyCombo('ctrl+@')).toEqual(['\x00']);
    expect(parseKeyCombo('ctrl+space')).toEqual(['\x00']);
    expect(parseKeyCombo('ctrl+[')).toEqual(['\x1b']);
  });

  it('preserves Ctrl+Shift and combined modifier bits in CSI-u', () => {
    expect(parseKeyCombo('ctrl+shift+p')).toEqual(['\x1b[112;6u']);
    expect(parseKeyCombo('ctrl+alt+shift+p')).toEqual(['\x1b[112;8u']);
  });

  it('formats captions from key names, including all function keys', () => {
    expect(formatComboCaption('ctrl+o')).toBe('^O');
    expect(formatComboCaption('alt+p')).toBe('Alt+P');
    expect(formatComboCaption('shift+tab')).toBe('⇧TAB');
    expect(formatComboCaption('esc esc')).toBe('ESC²');
    expect(formatComboCaption('ctrl+x m')).toBe('^X M');
    expect(formatComboCaption('ctrl+enter')).toBe('^⏎');
    expect(formatComboCaption('ctrl+m')).toBe('^M');
    expect(formatComboCaption('ctrl+i')).toBe('^I');
    for (let number = 1; number <= 12; number += 1) {
      expect(formatComboCaption(`f${number}`)).toBe(`F${number}`);
    }
  });

  it('rejects malformed combos with a field-ready error', () => {
    const captureError = (combo: string) => {
      try { parseKeyCombo(combo); } catch (error) { return error; }
      throw new Error('expected combo to be rejected');
    };
    expect(captureError('')).toBeInstanceOf(KeyComboError);
    expect(captureError('')).toMatchObject({ code: 'empty' });
    expect(captureError('ctrl++')).toMatchObject({ code: 'invalidStepSyntax' });
    expect(captureError('ctrl+unknown')).toMatchObject({ code: 'unsupportedKey', params: { step: 1, key: 'unknown' } });
  });
});
