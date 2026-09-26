import { act, render } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';

const Harness: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

function mount() {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Harness
        onReady={(value) => {
          ctx = value;
        }}
      />
    </TerminalProvider>,
  );
  return {
    exit(code: number | null, reason?: string) {
      act(() => {
        // @ts-expect-error emit is private; the relay drives it over the wire
        ctx?.adapter?.emit('exit', code, reason);
      });
    },
    get messages() {
      return (ctx?.toasts ?? []).map((toast) => toast.message);
    },
  };
}

describe('session ended toast', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSettings({ language: 'en' });
  });

  it('shows the exit code when the session reports one', () => {
    const view = mount();
    view.exit(0);
    expect(view.messages).toContain('Session ended (0)');
  });

  // The relay sends `code: null` when the shell ended without an exit status.
  it('leaves the code out when the relay sends none', () => {
    const view = mount();
    view.exit(null, 'host closed');
    expect(view.messages).toContain('Session ended: host closed');
  });
});
