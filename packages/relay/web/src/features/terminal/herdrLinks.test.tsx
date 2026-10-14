import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';

/**
 * A link Ctrl-clicked in Herdr is opened by the Herdr client that saw the
 * click. For a browser window that client runs on the workstation, which
 * hands the link back here: this window is where it opens.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

function mount() {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe
        onReady={(value) => {
          ctx = value;
        }}
      />
    </TerminalProvider>,
  );
  return (url: string) =>
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit('openLink', url);
    });
}

describe('links Herdr opens for this window', () => {
  const originalOpen = window.open;
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    saveSettings({ language: 'en' });
    open = vi.fn();
    window.open = open as unknown as typeof window.open;
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('opens a web link in a new tab that cannot reach back to this one', () => {
    const openLink = mount();
    openLink('https://example.com/pull/7');
    expect(open).toHaveBeenCalledWith(
      'https://example.com/pull/7',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('never opens anything outside the web schemes, whatever the relay passed on', () => {
    const openLink = mount();
    openLink('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
  });
});
