import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { UpdateChip } from '../components/UpdateNotice';
import { SessionStatusLine } from '../components/SessionStatusLine';
import { loadIgnoredUpdate, saveSettings } from '../utils/storage';

/**
 * A newer herdr-remote for the workstation, said on the status line.
 *
 * Checked by the host each time a window opens, so the same answer arrives
 * again and again: it may raise one toast per release, never one per window.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({ onReady }) => {
  onReady(useTerminal());
  return null;
};

function mount(children: React.ReactNode = <UpdateChip />) {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe onReady={(value) => { ctx = value; }} />
      {children}
    </TerminalProvider>,
  );
  const emit = (event: string, ...args: unknown[]) => {
    // @ts-expect-error test mock
    act(() => { ctx?.adapter?.emit(event, ...args); });
  };
  emit('ready', { type: 'ready', role: 'controller', hostId: 'host-a', hostname: 'workbox', clientId: 'client-1' });
  return {
    emit,
    report: (status: Record<string, unknown>) => emit('updateStatus', {
      type: 'update_status',
      current: '0.2.16',
      installed: '0.2.16',
      latest: '0.3.0',
      updateAvailable: true,
      restartPending: false,
      ...status,
    }),
    get toasts() {
      return ctx?.toasts ?? [];
    },
  };
}

describe('herdr-remote update notice', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSettings({ language: 'en' });
  });

  it('says nothing until the workstation reports, and nothing when it is current', () => {
    const session = mount();
    expect(screen.queryByTestId('update-chip')).not.toBeInTheDocument();

    session.report({ latest: '0.2.16', updateAvailable: false });
    expect(screen.queryByTestId('update-chip')).not.toBeInTheDocument();
  });

  it('shows the release on the status line and toasts it once, however often it is reported', () => {
    const session = mount();
    const before = session.toasts.length;

    session.report({});
    session.report({});
    session.emit('ready', { type: 'ready', role: 'controller', hostId: 'host-a', clientId: 'client-2' });
    session.report({});

    expect(screen.getByTestId('update-chip')).toHaveTextContent('herdr-remote 0.3.0');
    const announced = session.toasts.slice(before).filter((toast) => /0\.3\.0/.test(toast.message));
    expect(announced).toHaveLength(1);
  });

  it('explains how to update on the workstation, and can skip this release for good', () => {
    const session = mount();
    session.report({});

    fireEvent.click(screen.getByTestId('update-chip'));
    const modal = screen.getByTestId('update-modal');
    expect(modal).toHaveTextContent('workbox');
    expect(modal).toHaveTextContent('0.2.16');
    expect(modal).toHaveTextContent('npm install -g herdr-remote@0.3.0 --prefer-online');
    expect(modal).toHaveTextContent('herdr-remote restart');

    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }));
    expect(screen.queryByTestId('update-chip')).not.toBeInTheDocument();
    expect(loadIgnoredUpdate()).toBe('0.3.0');

    // The next release is news again.
    session.report({ latest: '0.3.1' });
    expect(screen.getByTestId('update-chip')).toHaveTextContent('0.3.1');
  });

  it('asks only for a restart when the update is already installed', () => {
    const session = mount();
    session.report({ installed: '0.3.0', restartPending: true });

    expect(screen.getByTestId('update-chip')).toHaveTextContent('restart for 0.3.0');
    fireEvent.click(screen.getByTestId('update-chip'));
    const modal = screen.getByTestId('update-modal');
    expect(modal).toHaveTextContent('herdr-remote restart');
    expect(modal).not.toHaveTextContent('npm install');
  });

  it('adds no empty segment to the status line when there is nothing to say', () => {
    const session = mount(<SessionStatusLine />);
    // The right-hand segments end with the tagline; count the separators there.
    const right = () => screen.getByText('remote terminal client').parentElement as HTMLElement;
    const separators = () => right().querySelectorAll(':scope > [aria-hidden="true"]').length;
    const before = separators();

    session.report({ latest: '0.2.16', updateAvailable: false });
    expect(separators()).toBe(before);

    session.report({});
    expect(within(right()).getByTestId('update-chip')).toBeInTheDocument();
    expect(separators()).toBe(before + 1);
  });

  it('never opens the right-hand segments with a separator for an agent chip that draws nothing', () => {
    const session = mount(<SessionStatusLine />);
    session.emit('agentStatus', { type: 'agent_status', counts: {}, total: 0, agents: [] });
    session.report({});

    const right = screen.getByText('remote terminal client').parentElement as HTMLElement;
    // Chip, separator, tagline: nothing invisible between them.
    expect(right.firstElementChild).toBe(screen.getByTestId('update-chip'));
    expect(right.querySelectorAll(':scope > [aria-hidden="true"]').length).toBe(1);
  });
});
