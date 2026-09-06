import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import {
  TerminalProvider,
  useTerminal,
  MAX_PENDING_OUTPUT_CHUNKS,
} from '../context/TerminalContext';
import { App } from '../App';
import { TerminalView } from '../components/TerminalView';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const TestControlHelper: React.FC<{
  onReady?: (ctx: ReturnType<typeof useTerminal>) => void;
}> = ({ onReady }) => {
  const ctx = useTerminal();
  onReady?.(ctx);
  return null;
};

const bytes = (text: string) => new TextEncoder().encode(text);
// Typed arrays from the Node realm fail `instanceof Uint8Array` under jsdom, so
// decode structurally instead of filtering by constructor identity.
const decode = (chunks: unknown[]) =>
  chunks
    .map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c as Uint8Array)))
    .join('');

describe('Session auto-connect', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
  });

  it('opens the relay socket on mount so output streams without any user action', async () => {
    // Regression: the provider used to build its adapter in an effect. React
    // flushes child effects first, so TerminalView's auto-connect ran against an
    // empty adapterRef and silently did nothing — the terminal sat on
    // "Terminal disconnected" until the user pressed Connect, and a browser
    // reload did not help.
    saveSettings({ token: 'test-token-autoconnect' });

    render(<App />);

    await waitFor(() => expect(webSocketInstances.length).toBe(1));
    expect(webSocketInstances[0].url).toContain('/ws/client');
  });

  it('exposes the adapter on the very first render, before any effect runs', () => {
    let adapterOnFirstRender: unknown = 'never rendered';
    render(
      <TerminalProvider>
        <TestControlHelper
          onReady={(ctx) => {
            if (adapterOnFirstRender === 'never rendered') {
              adapterOnFirstRender = ctx.adapter;
            }
          }}
        />
      </TerminalProvider>
    );

    expect(adapterOnFirstRender).not.toBeNull();
    expect(adapterOnFirstRender).not.toBe('never rendered');
  });

  it('sends the stored token in the hello frame it auto-connects with', async () => {
    saveSettings({ token: 'hello-frame-token' });

    render(<App />);

    await waitFor(() => expect(webSocketInstances.length).toBe(1));
    act(() => {
      webSocketInstances[0].simulateOpen();
    });

    const hello = JSON.parse(webSocketInstances[0].sent[0] as string);
    expect(hello.type).toBe('hello');
    expect(hello.token).toBe('hello-frame-token');
  });
});

describe('Live terminal output stream', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
  });

  it('buffers binary output in arrival order while no terminal sink is attached', () => {
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <TestControlHelper onReady={(c) => { ctx = c; }} />
      </TerminalProvider>
    );

    act(() => {
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes('one '));
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes('two '));
    });

    expect(ctx?.getPendingOutputChunkCount()).toBe(2);

    const received: Uint8Array[] = [];
    let unsubscribe: (() => void) | undefined;
    act(() => {
      unsubscribe = ctx?.subscribeToOutput((data) => received.push(data));
    });

    // Buffered chunks are replayed in order, then the queue is drained.
    expect(decode(received)).toBe('one two ');
    expect(ctx?.getPendingOutputChunkCount()).toBe(0);

    // Live chunks now go straight to the sink.
    act(() => {
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes('three'));
    });
    expect(decode(received)).toBe('one two three');
    expect(ctx?.getPendingOutputChunkCount()).toBe(0);

    // Detaching returns the stream to buffering rather than dropping output.
    act(() => {
      unsubscribe?.();
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes(' four'));
    });
    expect(decode(received)).toBe('one two three');
    expect(ctx?.getPendingOutputChunkCount()).toBe(1);

    // Re-attaching replays what was missed, preserving stream order.
    act(() => {
      ctx?.subscribeToOutput((data) => received.push(data));
    });
    expect(decode(received)).toBe('one two three four');
  });

  it('bounds the pending buffer so a long-hidden terminal cannot grow it forever', () => {
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <TestControlHelper onReady={(c) => { ctx = c; }} />
      </TerminalProvider>
    );

    act(() => {
      for (let i = 0; i < MAX_PENDING_OUTPUT_CHUNKS + 25; i++) {
        // @ts-expect-error emit is private; exercised directly in tests
        ctx?.adapter?.emit('binaryData', bytes('x'));
      }
    });

    expect(ctx?.getPendingOutputChunkCount()).toBeLessThanOrEqual(MAX_PENDING_OUTPUT_CHUNKS);
    expect(ctx?.getPendingOutputChunkCount()).toBeGreaterThan(0);
  });

  it('streams ANSI output into the live xterm instance, including while inactive', async () => {
    saveSettings({ token: 'test-token-stream' });

    let ctx: ReturnType<typeof useTerminal> | undefined;
    const { rerender } = render(
      <TerminalProvider>
        <TestControlHelper onReady={(c) => { ctx = c; }} />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );

    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];

    act(() => {
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes('live-output'));
    });

    expect(decode(term.writes)).toContain('live-output');
    expect(ctx?.getPendingOutputChunkCount()).toBe(0);

    // Going inactive (Admin on top) must not detach the sink or drop chunks.
    rerender(
      <TerminalProvider>
        <TestControlHelper onReady={(c) => { ctx = c; }} />
        <TerminalView isActive={false} />
      </TerminalProvider>
    );

    act(() => {
      // @ts-expect-error emit is private; exercised directly in tests
      ctx?.adapter?.emit('binaryData', bytes('|hidden-output'));
    });

    expect(term.disposed).toBe(false);
    expect(ctx?.getPendingOutputChunkCount()).toBe(0);
    expect(decode(term.writes)).toContain('live-output|hidden-output');
  });

  it('re-buffers the tail when the sink throws part-way through a replay', () => {
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <TestControlHelper onReady={(c) => { ctx = c; }} />
      </TerminalProvider>
    );

    act(() => {
      for (const text of ['a', 'b', 'c']) {
        // @ts-expect-error emit is private; exercised directly in tests
        ctx?.adapter?.emit('binaryData', bytes(text));
      }
    });
    expect(ctx?.getPendingOutputChunkCount()).toBe(3);

    // A sink that is not painted yet throws; the chunks it never took must stay
    // queued rather than being lost with the drained buffer.
    const received: Uint8Array[] = [];
    act(() => {
      ctx?.subscribeToOutput((data) => {
        if (received.length === 1) throw new Error('terminal not ready');
        received.push(data);
      });
    });

    expect(decode(received)).toBe('a');
    expect(ctx?.getPendingOutputChunkCount()).toBe(2);

    // Re-attaching a healthy sink replays the untaken tail, still in order.
    const recovered: Uint8Array[] = [];
    act(() => {
      ctx?.subscribeToOutput((data) => recovered.push(data));
    });
    expect(decode(recovered)).toBe('bc');
    expect(ctx?.getPendingOutputChunkCount()).toBe(0);
  });
});
