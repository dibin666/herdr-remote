import { describe, expect, it, vi } from 'vitest';
import type { IDisposable, Terminal } from '@xterm/xterm';
import { attachOsc52Clipboard } from './osc52Clipboard';

/**
 * OSC 52 clipboard writes from the remote session land in this window's
 * clipboard; everything else is swallowed without an answer.
 */

type OscHandler = (data: string) => boolean;

/** A terminal whose parser captures the OSC 52 handler the bridge registers. */
function fakeTerm() {
  const handlers = new Map<number, OscHandler>();
  const registration = { dispose: vi.fn() };
  const term = {
    parser: {
      registerOscHandler: vi.fn((id: number, handler: OscHandler) => {
        handlers.set(id, handler);
        return registration as unknown as IDisposable;
      }),
    },
  } as unknown as Terminal;
  return { term, handlers, registration };
}

const base64 = (text: string) => btoa(unescape(encodeURIComponent(text)));

describe('OSC 52 clipboard bridge', () => {
  it('decodes a clipboard write and hands the text over', () => {
    const { term, handlers } = fakeTerm();
    const writes: string[] = [];
    attachOsc52Clipboard(term, (text) => writes.push(text));

    expect(handlers.get(52)?.(`c;${base64('copied in herdr')}`)).toBe(true);
    expect(writes).toEqual(['copied in herdr']);
  });

  it('treats an empty target as the clipboard, and covers every selection target', () => {
    const { term, handlers } = fakeTerm();
    const writes: string[] = [];
    attachOsc52Clipboard(term, (text) => writes.push(text));

    for (const target of ['', 'c', 's', 'p', 'q', '0', '2', '7']) {
      handlers.get(52)?.(`${target};${base64('x')}`);
    }
    expect(writes).toHaveLength(8);
  });

  it('answers no read query, writes no non-clipboard target, and drops bad payloads', () => {
    const { term, handlers } = fakeTerm();
    const writes: string[] = [];
    attachOsc52Clipboard(term, (text) => writes.push(text));
    const handle = handlers.get(52)!;

    expect(handle('c;?')).toBe(true);
    expect(handle(`d;${base64('screen device')}`)).toBe(true);
    expect(handle(`c;${base64('a'.repeat(1_000_001))}`)).toBe(true);
    expect(handle('c;%%%not-base64%%%')).toBe(true);
    // An image payload is valid base64 but not text; it must not reach the
    // clipboard as mojibake.
    expect(handle('c;iVBORw0KGgoAAAANSUhEUg==')).toBe(true);
    expect(writes).toEqual([]);
  });
});
