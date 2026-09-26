import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostSwitcher } from './HostSwitcher';
import { TerminalProvider } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import { createConnectionProfile } from './connectionProfiles';

function profile(id: string, name: string, hostId: string) {
  return createConnectionProfile({
    id,
    displayName: name,
    wsUrl: 'wss://relay.example/ws/client',
    token: `${id}-token-123456789`,
    hostId,
    hostname: `${name.toLowerCase()}.example`,
  });
}

describe('HostSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows only browser-saved profiles and switches the active profile', async () => {
    const first = profile('profile-a', 'Office', 'host-a');
    const second = profile('profile-b', 'Home', 'host-b');
    saveSettings({
      profiles: [first, second],
      activeProfileId: first.id,
      wsUrl: first.wsUrl,
      token: first.token,
    });

    const add = vi.fn();
    render(
      <TerminalProvider>
        <HostSwitcher onAddProfile={add} />
      </TerminalProvider>,
    );

    const switcher = screen.getByRole('button', { name: 'Switch Herdr instance' });
    expect(switcher).toHaveTextContent('Office');
    fireEvent.click(switcher);
    expect(screen.getByRole('menu')).toHaveTextContent('Office');
    expect(screen.getByRole('menu')).toHaveTextContent('Home');

    fireEvent.click(screen.getByRole('menuitem', { name: /Home/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Herdr instance' })).toHaveTextContent(
        'Home',
      ),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('fits the desktop status line instead of standing out of it', () => {
    const first = profile('profile-a', 'Office', 'host-a');
    saveSettings({ profiles: [first], activeProfileId: first.id, wsUrl: first.wsUrl });
    render(
      <TerminalProvider>
        <HostSwitcher onAddProfile={() => {}} />
      </TerminalProvider>,
    );

    // A 24px button in the 20px status row made the whole page 3px taller
    // than the window, so focusing a dialog field scrolled the header off.
    const switcher = screen.getByRole('button', { name: 'Switch Herdr instance' });
    expect(switcher.className).not.toContain('min-h-[24px]');
    expect(switcher.className).toContain('h-full');
    expect(switcher.parentElement?.className).toContain('h-full');
  });

  it('opens the add-profile action without exposing tokens', () => {
    const first = profile('profile-a', 'Office', 'host-a');
    saveSettings({
      profiles: [first],
      activeProfileId: first.id,
      wsUrl: first.wsUrl,
      token: first.token,
    });
    const add = vi.fn();
    render(
      <TerminalProvider>
        <HostSwitcher onAddProfile={add} />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch Herdr instance' }));
    expect(screen.queryByText(first.token)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Herdr instance' }));
    expect(add).toHaveBeenCalledTimes(1);
  });
});
