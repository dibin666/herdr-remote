import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WS_CLIENT_PATH } from '@protocol/messages';
import { ToastContainer } from '@/app/ToastContainer';
import { TerminalProvider } from '@/context/TerminalContext';
import { loadSettings, saveSettings } from '@/features/settings/storage';
import { AddHostModal } from './AddHostModal';
import { createConnectionProfile } from './connectionProfiles';

function renderWithOwnHost() {
  const own = createConnectionProfile({
    id: 'profile-own',
    displayName: 'Office',
    wsUrl: 'wss://relay.example/ws/client',
    token: 'own-device-token-123456',
    hostId: 'host-own',
  });
  saveSettings({ profiles: [own], activeProfileId: own.id, wsUrl: own.wsUrl, token: own.token });
  render(
    <TerminalProvider>
      <AddHostModal isOpen={true} onClose={() => {}} />
      <ToastContainer />
    </TerminalProvider>,
  );
  return own;
}

describe('AddHostModal', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('asks for nothing but the pairing code, and nothing about the open instance', () => {
    renderWithOwnHost();

    expect(screen.getByLabelText(/Pairing Code/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Relay WebSocket/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Client Identifier/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Host Name/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Office')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.getByLabelText(/Relay WebSocket/)).toHaveValue(WS_CLIENT_PATH);
    expect(screen.getByLabelText(/Access Token/)).toHaveValue('');
  });

  it('adds a new instance from the code alone and leaves the existing one as it was', () => {
    const own = renderWithOwnHost();

    fireEvent.change(screen.getByLabelText(/Pairing Code/), { target: { value: 'ab12cd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair & Connect' }));

    const saved = loadSettings();
    expect(saved.profiles).toHaveLength(2);
    expect(saved.profiles.find((item) => item.id === own.id)).toMatchObject({
      token: own.token,
      wsUrl: own.wsUrl,
    });
    const added = saved.profiles.find((item) => item.id !== own.id);
    expect(added).toMatchObject({ pairCode: 'AB12CD', token: '', wsUrl: WS_CLIENT_PATH });
    expect(saved.activeProfileId).toBe(added?.id);
  });

  it('adds nothing without a code or a token', () => {
    renderWithOwnHost();

    fireEvent.click(screen.getByRole('button', { name: 'Pair & Connect' }));

    expect(loadSettings().profiles).toHaveLength(1);
    expect(screen.getByText('Enter a pairing code or device token.')).toBeInTheDocument();
  });
});
