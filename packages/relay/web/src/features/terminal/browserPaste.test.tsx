import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import type { MockTerminalInstance } from '@/test/setup';
import { TerminalProvider } from '@/context/TerminalContext';
import { TerminalView } from './TerminalView';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', ...init });
}

describe('browser clipboard paste shortcut', () => {
  beforeEach(() => {
    xtermInstances.length = 0;
  });

  it('lets Ctrl/Cmd+V reach the browser paste event instead of sending C0.SYN', async () => {
    render(
      <TerminalProvider>
        <TerminalView isActive={true} />
      </TerminalProvider>,
    );
    await waitFor(() => expect(xtermInstances).toHaveLength(1));

    const handler = xtermInstances[0].customKeyEventHandler;
    expect(handler).toBeDefined();
    expect(handler?.(key({ ctrlKey: true }))).toBe(false);
    expect(handler?.(key({ metaKey: true }))).toBe(false);
    expect(handler?.(key({ ctrlKey: true, key: 'c', code: 'KeyC' }))).toBe(true);
    expect(handler?.(key({ key: 'v', code: 'KeyV' }))).toBe(true);
  });
});
