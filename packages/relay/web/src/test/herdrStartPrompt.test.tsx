import type React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { HerdrStartPrompt } from '../components/HerdrStartPrompt';
import { saveSettings } from '../utils/storage';

/**
 * Herdr is not running on the paired workstation.
 *
 * The window asks before anything starts, names the machine it would start it
 * on, and says so in place of the empty terminal rather than in a toast that
 * scrolls away.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

function mountPrompt() {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe
        onReady={(value) => {
          ctx = value;
        }}
      />
      <HerdrStartPrompt />
    </TerminalProvider>,
  );
  const emit = (event: string, ...args: unknown[]) => {
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit(event, ...args);
    });
  };
  const sendHerdrStart = vi.spyOn(ctx!.adapter!, 'sendHerdrStart').mockImplementation(() => {});
  emit('ready', {
    type: 'ready',
    role: 'controller',
    hostId: 'host-a',
    hostname: 'workbox',
    clientId: 'client-1',
  });
  return {
    emit,
    sendHerdrStart,
    get toasts() {
      return ctx?.toasts ?? [];
    },
  };
}

describe('Starting Herdr from the browser', () => {
  beforeEach(() => {
    localStorage.clear();
    saveSettings({ language: 'en' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks, naming the workstation, instead of raising an error', () => {
    const session = mountPrompt();
    expect(screen.queryByTestId('herdr-start-prompt')).not.toBeInTheDocument();
    const toastsBefore = session.toasts.length;

    session.emit('error', {
      code: 'herdr_not_running',
      message: 'Herdr is not running on this workstation.',
    });

    const prompt = screen.getByTestId('herdr-start-prompt');
    expect(prompt).toHaveTextContent('Herdr is not running on workbox');
    expect(screen.getByRole('button', { name: 'Start Herdr' })).toBeInTheDocument();
    expect(session.toasts.length).toBe(toastsBefore);
    // Nothing starts until the user says so.
    expect(session.sendHerdrStart).not.toHaveBeenCalled();
  });

  it('starts it on request and gets out of the way once the terminal is up', () => {
    const session = mountPrompt();
    session.emit('error', { code: 'herdr_not_running', message: '' });

    fireEvent.click(screen.getByRole('button', { name: 'Start Herdr' }));

    expect(session.sendHerdrStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('herdr-start-prompt')).toHaveTextContent('Starting Herdr on workbox');
    expect(screen.queryByRole('button', { name: 'Start Herdr' })).not.toBeInTheDocument();

    session.emit('sessionReady', { type: 'session_ready' });
    expect(screen.queryByTestId('herdr-start-prompt')).not.toBeInTheDocument();
  });

  it('shows why a start failed and offers to try again', () => {
    const session = mountPrompt();
    session.emit('error', { code: 'herdr_not_running', message: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Start Herdr' }));

    session.emit('error', {
      code: 'herdr_start_failed',
      message: 'Herdr server exited (code 1) before opening its socket.',
    });

    const prompt = screen.getByTestId('herdr-start-prompt');
    expect(prompt).toHaveTextContent('Herdr did not start');
    expect(prompt).toHaveTextContent('exited (code 1)');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(session.sendHerdrStart).toHaveBeenCalledTimes(2);
  });

  it('stops waiting on a workstation that never answers', () => {
    vi.useFakeTimers();
    const session = mountPrompt();
    session.emit('error', { code: 'herdr_not_running', message: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Start Herdr' }));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByTestId('herdr-start-prompt')).toHaveTextContent(
      'too old to start Herdr from a browser',
    );
  });

  it('forgets the question when the connection goes, and asks the next one afresh', () => {
    const session = mountPrompt();
    session.emit('error', { code: 'herdr_not_running', message: '' });

    session.emit('stateChange', 'reconnecting', undefined, undefined);

    expect(screen.queryByTestId('herdr-start-prompt')).not.toBeInTheDocument();
  });
});
