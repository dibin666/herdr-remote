import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { loadSettings } from '@/features/settings/storage';
import { STORAGE_KEYS } from '@/shared/lib/browserStorage';
import { ControlModeSwitch } from './ControlModeSwitch';

let ctx: ReturnType<typeof useTerminal> | undefined;
const Capture: React.FC = () => {
  ctx = useTerminal();
  return null;
};

const encoder = new TextEncoder();
const WHEEL_UP = encoder.encode('\x1b[<64;10;5M');

function renderConnected() {
  render(
    <TerminalProvider>
      <Capture />
      <ControlModeSwitch />
    </TerminalProvider>,
  );
  act(() => {
    // @ts-expect-error test mock
    ctx?.adapter?.emit('stateChange', 'connected');
    // @ts-expect-error test mock
    ctx?.adapter?.emit('ready', {
      type: 'ready',
      role: 'controller',
      controllerId: null,
      hostId: 'host-1',
      clientId: 'client-1',
    });
  });
  const adapter = ctx?.adapter;
  if (!adapter) throw new Error('no adapter');
  return vi.spyOn(adapter, 'sendInput').mockImplementation(() => {});
}

describe('ControlModeSwitch', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    ctx = undefined;
  });

  it('holds this window back from typing while it observes, and lets it scroll', () => {
    const sendInput = renderConnected();

    fireEvent.click(screen.getByRole('radio', { name: 'Viewer' }));
    expect(ctx?.isController).toBe(false);
    expect(loadSettings().observerMode).toBe(true);
    act(() => {
      ctx?.sendKey('x');
      ctx?.sendBinary(encoder.encode('y'));
    });
    expect(sendInput).not.toHaveBeenCalled();
    act(() => ctx?.sendBinary(WHEEL_UP));
    expect(sendInput).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('radio', { name: 'Full control' }));
    expect(ctx?.isController).toBe(true);
    act(() => ctx?.sendKey('x'));
    expect(sendInput).toHaveBeenCalledTimes(2);
  });

  it('keeps observing through a reload of this window only', () => {
    renderConnected();
    fireEvent.click(screen.getByRole('radio', { name: 'Viewer' }));
    // Another window, or this one reopened later, starts with full control.
    expect(localStorage.getItem(STORAGE_KEYS.settings)).not.toContain('observerMode');

    const reloaded = loadSettings();
    expect(reloaded.observerMode).toBe(true);
  });
});
