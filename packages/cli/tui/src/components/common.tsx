import React, { useEffect, useRef } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useMouseTarget } from '../mouse/index.js';
import {
  SELECTED_MARKER,
  STATUS_COLOR,
  STATUS_GLYPH,
  UNSELECTED_MARKER,
  theme,
  type StatusLevel,
} from '../theme.js';

export function StatusDot({ level }: { level: StatusLevel }) {
  return <Text color={STATUS_COLOR[level]}>{STATUS_GLYPH[level]}</Text>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <Text color={theme.muted}>{children}</Text>;
}

// Wide enough for the longest label in either language plus a separating
// space. Too narrow and Ink wraps the label onto a second line or butts it
// straight against its value.
const LABEL_COLUMN_WIDTH = 20;

/** A `label   value` row with the labels aligned into a column. */
export function Row({
  label,
  labelWidth = LABEL_COLUMN_WIDTH,
  children,
}: {
  label: string;
  labelWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={theme.muted} wrap="truncate-end">{label}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

export type SelectableProps = {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onHover?: () => void;
  children: React.ReactNode;
};

/**
 * One row of a list that responds to both the keyboard and the mouse.
 *
 * Each row is its own component because the mouse hooks bind to a ref: mapping
 * over items in the parent and calling hooks inline would make the hook order
 * depend on the list length.
 *
 * The row stretches to the full width of its container so the whole line is a
 * click target, not just the few columns the label happens to occupy.
 */
export function Selectable({ selected, disabled = false, onSelect, onHover, children }: SelectableProps) {
  const ref = useRef<DOMElement>(null);
  const hovered = useMouseTarget(ref, { disabled, onClick: onSelect });
  useFollowPointer(hovered, onHover);

  const active = selected || hovered;
  const color = disabled ? theme.muted : active ? theme.accent : undefined;

  return (
    <Box ref={ref}>
      <Text color={active ? theme.accent : undefined}>
        {active ? SELECTED_MARKER : UNSELECTED_MARKER}
        {' '}
      </Text>
      <Text color={color} bold={active} dimColor={disabled}>
        {children}
      </Text>
    </Box>
  );
}

/**
 * Move the keyboard cursor to whatever the pointer is over.
 *
 * Without this the two run independently and a list shows two markers at once —
 * one where the keyboard is, one under the mouse — leaving it ambiguous which
 * one Enter would activate.
 */
function useFollowPointer(hovered: boolean, onHover?: () => void) {
  const handler = useRef(onHover);
  handler.current = onHover;
  useEffect(() => {
    if (hovered) handler.current?.();
  }, [hovered]);
}

/**
 * Keyboard/mouse driven list. `onChange` moves the highlight, `onSelect`
 * activates an entry.
 */
export function Menu<T extends { id: string; label: string; disabled?: boolean }>({
  items,
  selectedId,
  onChange,
  onSelect,
}: {
  items: T[];
  selectedId: string;
  onChange: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Selectable
          key={item.id}
          selected={item.id === selectedId}
          disabled={item.disabled}
          onSelect={() => onSelect(item.id)}
          onHover={() => onChange(item.id)}
        >
          {item.label}
        </Selectable>
      ))}
    </Box>
  );
}

/**
 * A `label  value` row that is clickable across its whole width.
 *
 * Used for settings: clicking anywhere on the line — label or value — starts
 * editing it, which is what a pointer user expects.
 */
export function FieldRow({
  label,
  selected,
  disabled = false,
  labelWidth = 22,
  onSelect,
  onHover,
  children,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  labelWidth?: number;
  onSelect: () => void;
  onHover?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<DOMElement>(null);
  const hovered = useMouseTarget(ref, { disabled, onClick: onSelect });
  useFollowPointer(hovered, onHover);
  const active = selected || hovered;

  return (
    <Box ref={ref}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={active ? theme.accent : undefined}>
          {active ? SELECTED_MARKER : UNSELECTED_MARKER}
          {' '}
        </Text>
        <Text color={active ? theme.accent : theme.muted} bold={active} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

/** A framed panel used for every screen body, so the layout stays predictable. */
export function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} flexGrow={1}>
      {title ? (
        <Box marginBottom={1}>
          <Text bold>{title}</Text>
        </Box>
      ) : null}
      {children}
    </Box>
  );
}

/** Feedback from the last action. Colour is the only signal, no icons. */
export function Message({ text, level }: { text: string | null; level: 'info' | 'success' | 'error' }) {
  if (!text) return null;
  const color = level === 'error' ? theme.bad : level === 'success' ? theme.ok : theme.muted;
  return (
    <Box marginTop={1}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}
