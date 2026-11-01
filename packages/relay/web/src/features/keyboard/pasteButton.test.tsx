import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyToolbar } from './KeyToolbar';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import * as clipboardModule from '@/shared/lib/clipboard';

describe('KeyToolbar paste button', () => {
  let terminalCtx: ReturnType<typeof useTerminal> | undefined;

  const CaptureContext = () => {
    terminalCtx = useTerminal();
    return null;
  };

  const renderToolbar = () => {
    terminalCtx = undefined;
    return render(
      <TerminalProvider>
        <CaptureContext />
        <KeyToolbar />
      </TerminalProvider>,
    );
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens the manual paste box and sends the typed text', async () => {
    vi.spyOn(clipboardModule, 'readClipboardImage').mockResolvedValue({
      ok: false,
      reason: 'insecure',
    });
    vi.spyOn(clipboardModule, 'readClipboardText').mockResolvedValue({
      ok: false,
      reason: 'insecure',
    });
    saveSettings({ language: 'zh', toolbarVisible: true });
    renderToolbar();
    await waitFor(() => expect(terminalCtx).toBeDefined());
    act(() => {
      const adapter = terminalCtx?.adapter as unknown as { emit: (name: string) => void } | null;
      adapter?.emit('controlGranted');
    });
    await waitFor(() => expect(terminalCtx?.isController).toBe(true));

    const inputSpy = vi.fn();
    const unsub = terminalCtx!.observeKeyInput(inputSpy);
    fireEvent.click(await screen.findByTestId('paste-btn'));
    const textarea = await screen.findByTestId('paste-fallback-input');
    fireEvent.change(textarea, { target: { value: 'git pull origin main' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(inputSpy).toHaveBeenCalled());
    expect(inputSpy.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      'git pull origin main',
    ]);
    unsub();
  });
});
