import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalProvider } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import { SessionStatusLine } from './SessionStatusLine';

// The status line is one 20px row. A segment allowed to wrap broke into two
// lines that spilled over its neighbours ("在线" stacked as 在/线, a long
// host id drawn across the client id) instead of giving up its own width.
describe('session status line', () => {
  beforeEach(() => {
    localStorage.clear();
    saveSettings({ language: 'zh', clientId: `client-${'x'.repeat(80)}` });
  });

  it('keeps every segment on its one line', () => {
    render(
      <TerminalProvider>
        <SessionStatusLine />
      </TerminalProvider>,
    );

    const segments = screen.getByTestId('status-line-segments');
    for (const segment of Array.from(segments.children)) {
      if (segment.getAttribute('aria-hidden') === 'true') continue;
      expect(segment.className, segment.textContent ?? '').toContain('whitespace-nowrap');
    }
  });

  it('lets the long ids give way, never the connection state', () => {
    render(
      <TerminalProvider>
        <SessionStatusLine />
      </TerminalProvider>,
    );

    const client = screen.getByText(/^client-x+$/).parentElement as HTMLElement;
    expect(client.className).toContain('truncate');
    expect(client.className).toContain('min-w-0');
    const state = screen.getByText('离线').parentElement as HTMLElement;
    expect(state.className).toContain('shrink-0');
  });

  it('keeps the instance name inside its own button', () => {
    render(
      <TerminalProvider>
        <SessionStatusLine />
      </TerminalProvider>,
    );

    const switcher = screen.getByRole('button', { name: '切换 Herdr 实例' });
    // Without min-w-0 a flex item never shrinks below its text, so `truncate`
    // never cut and the name ran under the connection state beside it.
    const label = switcher.querySelector('.truncate') as HTMLElement;
    expect(label.className).toContain('min-w-0');
    expect((switcher.parentElement as HTMLElement).className).toContain('shrink-0');
  });
});
