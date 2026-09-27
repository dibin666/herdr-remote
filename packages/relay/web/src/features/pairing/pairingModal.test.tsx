import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TerminalProvider } from '@/context/TerminalContext';
import { loadSettings, saveSettings } from '@/features/settings/storage';
import { createConnectionProfile } from './connectionProfiles';
import { PairingModal } from './PairingModal';

describe('PairingModal', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const own = createConnectionProfile({
      id: 'profile-own',
      displayName: 'Office',
      wsUrl: '/ws/client',
      token: 'own-device-token-123456',
    });
    saveSettings({ profiles: [own], activeProfileId: own.id, wsUrl: own.wsUrl, token: own.token });
    render(
      <TerminalProvider>
        <PairingModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );
  });

  it('shows the name and a pairing code, and folds the rest away', () => {
    expect(screen.getByLabelText('Host Name')).toHaveValue('Office');
    expect(screen.getByLabelText(/Pairing Code/)).toHaveValue('');
    expect(screen.queryByLabelText(/Access Token/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Relay WebSocket/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Client Identifier')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pairing link/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.getByLabelText(/Access Token/)).toHaveValue('own-device-token-123456');
    expect(screen.getByLabelText(/Relay WebSocket/)).toHaveValue('/ws/client');
    expect(screen.getByLabelText('Client Identifier')).toBeInTheDocument();
  });

  it('saves a rename of the open instance', () => {
    fireEvent.change(screen.getByLabelText('Host Name'), { target: { value: 'Studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }));
    expect(loadSettings().profiles[0]).toMatchObject({
      displayName: 'Studio',
      token: 'own-device-token-123456',
    });
  });
});
