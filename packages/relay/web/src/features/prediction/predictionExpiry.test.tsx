import type { Terminal } from '@xterm/xterm';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestScreen } from '@/test/helpers/screenFixture';
import { usePredictiveEcho } from './usePredictiveEcho';

afterEach(() => vi.useRealTimers());

it('removes unacknowledged predictions even when the server and user go silent', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const screen = createTestScreen(80, 12);
  screen.write(5, 0, 'Message: ');
  screen.setCursor(9, 5);
  const term = screen as unknown as Terminal;
  const { result, unmount } = renderHook(() =>
    usePredictiveEcho({
      termRef: { current: term },
      rendererRef: { current: null },
      mode: 'always',
      connectionState: 'connected',
      observeKeyInput: () => () => {},
      herdrPrefixKeys: undefined,
    }),
  );
  act(() => {
    const parts = result.current.attach(term);
    result.current.onUserInput(new TextEncoder().encode('ab'));
    screen.write(5, 9, 'ab');
    screen.setCursor(11, 5);
    parts.fieldProbe.invalidate();
    parts.predictor.onServerOutput();
    result.current.onUserInput(new TextEncoder().encode('c'));
  });
  expect(result.current.overlayRef.current?.hasItems()).toBe(true);
  act(() => vi.advanceTimersByTime(5_000));
  expect(result.current.overlayRef.current?.hasItems()).toBe(false);
  act(() => result.current.detach());
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
