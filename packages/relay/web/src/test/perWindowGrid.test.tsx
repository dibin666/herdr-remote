import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { HerdrClientAdapter } from '../protocol/clientAdapter';

/**
 * Each window runs its own PTY session and drives its own grid.
 *
 * Every attached browser measures its own container, paints to that capacity,
 * and announces its dimensions to the relay via sendResize. No window shrinks
 * to fit another, and there is no shared grid imposed across windows.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  const ctx = useTerminal();
  onReady(ctx);
  return (
    <span data-testid="grid">
      {('sharedGrid' in (ctx as unknown as Record<string, unknown>)) ? 'external' : 'per-window'}
    </span>
  );
};

describe('Per-window terminal grid', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('announces the window’s own measured grid to the relay via sendResize', () => {
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

    // Stand in for a live socket so sendResize has somewhere to write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).ws = {
      readyState: 1,
      send: (frame: string) => sent.push(frame),
    };

    adapter.sendResize(120, 40);

    const resize = sent.map((frame) => JSON.parse(frame)).find((msg) => msg.type === 'resize');
    expect(resize).toMatchObject({ type: 'resize', cols: 120, rows: 40 });

    adapter.sendHello();
    const hello = sent.map((frame) => JSON.parse(frame)).find((msg) => msg.type === 'hello');
    expect(hello).toMatchObject({ cols: 120, rows: 40 });
  });

  it('does not expose or impose any external shared grid on this window', () => {
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <Probe onReady={(value) => { ctx = value; }} />
      </TerminalProvider>
    );

    expect(ctx).toBeDefined();
    // @ts-expect-error verifying sharedGrid is no longer present on context
    expect(ctx?.sharedGrid).toBeUndefined();
    expect(screen.getByTestId('grid').textContent).toBe('per-window');
  });

  it('gracefully ignores obsolete shared_resize messages from older relays', () => {
    const adapter = new HerdrClientAdapter({
      wsUrl: '/ws/client',
      clientId: 'window-1',
      autoReconnect: false,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: 0,
      pingIntervalMs: 10000,
      token: 'token',
    });

    adapter.sendResize(120, 40);

    // Older relays might still broadcast shared_resize; ensure processing it is a safe no-op.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).processJsonMessage({ type: 'shared_resize', cols: 40, rows: 20 });
    }).not.toThrow();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).terminalCols).toBe(120);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).terminalRows).toBe(40);
  });
});
