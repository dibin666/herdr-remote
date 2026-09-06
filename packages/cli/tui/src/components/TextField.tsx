import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

// Anything below 0x20, plus DEL: escape sequences and control keys that must
// never end up as literal text in a field.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export type TextFieldProps = {
  value: string;
  placeholder?: string;
  active: boolean;
  mask?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

/**
 * A single-line editor.
 *
 * Small enough to own rather than depend on: the TUI needs exactly one editing
 * affordance, and keeping it here means the escape/confirm contract is the same
 * everywhere and stays consistent with `useInput({ isActive })` gating, so a
 * keystroke never lands in both the editor and the surrounding menu.
 */
export function TextField({ value, placeholder, active, mask = false, onSubmit, onCancel }: TextFieldProps) {
  const [buffer, setBuffer] = useState(value);

  useEffect(() => {
    if (active) setBuffer(value);
  }, [active, value]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(buffer);
      return;
    }
    if (key.escape) {
      setBuffer(value);
      onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'u') {
      setBuffer('');
      return;
    }
    if (input && !key.ctrl && !key.meta && !CONTROL_CHARACTERS.test(input)) {
      setBuffer((current) => current + input);
    }
  }, { isActive: active });

  const display = active ? buffer : value;
  const shown = mask && display ? '•'.repeat(Math.min(display.length, 32)) : display;

  if (!active) {
    return shown
      ? <Text>{shown}</Text>
      : <Text color={theme.muted}>{placeholder ?? ''}</Text>;
  }

  return (
    <Box>
      <Text color={theme.accent}>{shown}</Text>
      <Text color={theme.accent} inverse>{' '}</Text>
    </Box>
  );
}
