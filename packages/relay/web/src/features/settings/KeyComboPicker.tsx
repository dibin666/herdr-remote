import { useEffect, useRef, useState } from 'react';
import { useSettings } from '@/context/TerminalContext';
import { formatComboCaption, parseKeyCombo } from '@/shared/keys/keyCombo';
import { Button, KeyCap, Modal } from '@/shared/ui';

type KeyToken = { token: string; label: string };

type ComboStep = { id: number; combo: string };

const MODIFIERS = ['ctrl', 'alt', 'shift'] as const;
const CHARACTER_ROWS: KeyToken[][] = [
  [...'1234567890'].map((token) => ({ token, label: token })),
  [...'qwertyuiop'].map((token) => ({ token, label: token.toUpperCase() })),
  [...'asdfghjkl'].map((token) => ({ token, label: token.toUpperCase() })),
  [...'zxcvbnm'].map((token) => ({ token, label: token.toUpperCase() })),
  ['-', '=', '[', ']', 'backslash', ';', "'", ',', '.', '/', 'plus'].map((token) => ({
    token,
    label: token === 'backslash' ? '\\' : token === 'plus' ? '+' : token,
  })),
];
const SPECIAL_KEYS: KeyToken[] = [
  { token: 'esc', label: 'ESC' },
  { token: 'tab', label: 'TAB' },
  { token: 'space', label: 'SPACE' },
  { token: 'enter', label: 'ENTER' },
  { token: 'backspace', label: '⌫' },
  { token: 'delete', label: 'DEL' },
  { token: 'insert', label: 'INS' },
  { token: 'home', label: 'HOME' },
  { token: 'end', label: 'END' },
  { token: 'pageup', label: 'PGUP' },
  { token: 'pagedown', label: 'PGDN' },
  { token: 'left', label: '←' },
  { token: 'up', label: '↑' },
  { token: 'down', label: '↓' },
  { token: 'right', label: '→' },
  ...Array.from({ length: 12 }, (_, index) => ({ token: `f${index + 1}`, label: `F${index + 1}` })),
];
const KEY_BUTTON_CLASS =
  'tui-focusable min-w-0 border border-tui-border bg-tui-mantle px-1.5 py-1 text-tui-sm font-bold text-tui-text transition-colors hover:border-tui-accent hover:text-tui-accent';

function readSteps(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    parseKeyCombo(trimmed);
    return trimmed.split(/\s+/);
  } catch {
    return [];
  }
}

export function KeyComboPicker({
  isOpen,
  value,
  onClose,
  onApply,
}: {
  isOpen: boolean;
  value: string;
  onClose: () => void;
  onApply: (combo: string) => void;
}) {
  const { t } = useSettings();
  const [steps, setSteps] = useState<ComboStep[]>([]);
  const nextStepIdRef = useRef(0);
  const [modifiers, setModifiers] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    nextStepIdRef.current = 0;
    setSteps(readSteps(value).map((combo) => ({ id: nextStepIdRef.current++, combo })));
    setModifiers([]);
  }, [isOpen, value]);

  const toggleModifier = (modifier: (typeof MODIFIERS)[number]) => {
    setModifiers((current) =>
      current.includes(modifier)
        ? current.filter((item) => item !== modifier)
        : [...current, modifier],
    );
  };

  const addKey = (key: string) => {
    if (steps.length >= 8) return;
    const combo = [...modifiers, key].join('+');
    setSteps((current) => [...current, { id: nextStepIdRef.current++, combo }]);
    setModifiers([]);
  };

  const combo = steps.map((step) => step.combo).join(' ');
  const canApply = steps.length > 0 && modifiers.length === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('agentKeymaps.comboPickerTitle')}
      closeLabel={t('common.closeDialog')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!canApply}
            onClick={() => onApply(combo)}
            data-testid="combo-picker-apply"
          >
            {t('agentKeymaps.comboPickerApply')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-tui-sm text-tui-faint">{t('agentKeymaps.comboPickerHint')}</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-tui-sm text-tui-muted">
              {t('agentKeymaps.comboPickerSelection')}
            </span>
            <Button
              variant="ghost"
              disabled={steps.length === 0 && modifiers.length === 0}
              onClick={() => {
                setSteps([]);
                setModifiers([]);
              }}
            >
              {t('agentKeymaps.comboPickerClear')}
            </Button>
          </div>
          <div
            data-testid="combo-picker-selection"
            className="flex min-h-9 flex-wrap items-center gap-1 border border-tui-border-dim bg-tui-crust p-1"
          >
            {steps.map((step, index) => {
              let caption = step.combo;
              try {
                caption = formatComboCaption(step.combo);
              } catch {
                // Invalid text drafts are omitted when the visual picker opens.
              }
              return (
                <span key={step.id} className="inline-flex items-center gap-1">
                  <KeyCap>{caption}</KeyCap>
                  <button
                    type="button"
                    aria-label={t('agentKeymaps.comboPickerRemoveStep', { step: index + 1 })}
                    className="tui-focusable text-tui-faint hover:text-tui-bad"
                    onClick={() =>
                      setSteps((current) => current.filter((item) => item.id !== step.id))
                    }
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {modifiers.map((modifier) => (
              <KeyCap key={modifier} active>
                {modifier.toUpperCase()}
              </KeyCap>
            ))}
            {steps.length === 0 && modifiers.length === 0 && (
              <span className="px-1 text-tui-sm text-tui-faint">
                {t('agentKeymaps.comboPickerEmpty')}
              </span>
            )}
          </div>
        </div>

        <div>
          <p className="mb-1 text-tui-sm text-tui-muted">
            {t('agentKeymaps.comboPickerModifiers')}
          </p>
          <div className="flex gap-1">
            {MODIFIERS.map((modifier) => (
              <button
                key={modifier}
                type="button"
                aria-pressed={modifiers.includes(modifier)}
                onClick={() => toggleModifier(modifier)}
                className={`${KEY_BUTTON_CLASS} ${modifiers.includes(modifier) ? 'border-tui-accent bg-tui-accent text-tui-crust' : ''}`}
              >
                {modifier.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="sr-only">{t('agentKeymaps.comboPickerKeyboard')}</legend>
          {CHARACTER_ROWS.map((row) => (
            <div key={row.map(({ token }) => token).join('-')} className="grid grid-cols-10 gap-1">
              {row.map(({ token, label }) => (
                <button
                  key={token}
                  type="button"
                  aria-label={label}
                  className={KEY_BUTTON_CLASS}
                  disabled={steps.length >= 8}
                  onClick={() => addKey(token)}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
          <div className="flex flex-wrap gap-1">
            {SPECIAL_KEYS.map(({ token, label }) => (
              <button
                key={token}
                type="button"
                aria-label={label}
                className={KEY_BUTTON_CLASS}
                disabled={steps.length >= 8}
                onClick={() => addKey(token)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
