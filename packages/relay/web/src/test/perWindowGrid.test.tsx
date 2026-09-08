import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { HerdrClientAdapter } from '../protocol/clientAdapter';

/**
 * The grid is the session's, not the window's.
 *
 * Every browser attached to a workstation paints the same grid, because the
 * workstation wrapped the stream for the smallest of them. A window that kept
 * rendering at its own width would show something none of the others is
 * showing — and it must still *report* its own width, or the relay could never
 * work out what the smallest one is.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  const ctx = useTerminal();
  onReady(ctx);
  return (
    <span data-testid="grid">
      {ctx.sharedGrid ? `${ctx.sharedGrid.cols}x${ctx.sharedGrid.rows}` : 'none'}
    </span>
  );
};

describe('Shared terminal grid', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('adopts the grid the relay announces for the shared session', () => {
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <Probe onReady={(value) => { ctx = value; }} />
      </TerminalProvider>
    );

    expect(screen.getByTestId('grid').textContent).toBe('none');

    act(() => {
      // @ts-expect-error the adapter's emitter is exercised directly here
      ctx?.adapter?.emit('sharedResize', 49, 40);
    });

    expect(screen.getByTestId('grid').textContent).toBe('49x40');
  });

  it('keeps announcing this window’s own capacity, not the shared grid', () => {
    const sent: string[] = [];
    const adapter = new HerdrClientAdapter({
      wsUrl: '/ws/client',
      clientId: 'window-1',
      autoReconnect: false,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: 0,
      pingIntervalMs: 10000,
      token: 'token',
    });

    // Stand in for a live socket so `sendHello` has somewhere to write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).ws = {
      readyState: 1,
      send: (frame: string) => sent.push(frame),
    };

    adapter.sendResize(120, 40);

    // The relay announces a smaller shared grid, because a phone joined.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).processJsonMessage({ type: 'shared_resize', cols: 49, rows: 40 });

    adapter.sendHello();

    const hello = sent.map((frame) => JSON.parse(frame)).find((msg) => msg.type === 'hello');
    expect(hello).toMatchObject({ cols: 120, rows: 40 });
  });
});
