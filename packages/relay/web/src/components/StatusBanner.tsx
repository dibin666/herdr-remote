import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { Button, GLYPH, Spinner, StatusLevel, TONE } from './tui';

/**
 * The connection line, drawn between the header and the grid.
 *
 * One row, one colour, one action. A TUI does not stack a coloured card over
 * its content to tell you the link is down; it writes it on a status line and
 * leaves the terminal where it was.
 */

const Line: React.FC<{
  tone: StatusLevel;
  glyph: React.ReactNode;
  message: string;
  assertive?: boolean;
  action?: React.ReactNode;
}> = ({ tone, glyph, message, assertive = false, action }) => (
  <aside
    className={cn(
      'flex w-full items-center justify-between gap-3 border-b bg-tui-mantle px-2 py-0.5 text-tui sm:px-3',
      TONE[tone].edgeB
    )}
    aria-live={assertive ? 'assertive' : 'polite'}
  >
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className={cn('shrink-0', TONE[tone].text)}>
        {glyph}
      </span>
      <span className="truncate text-tui-text">{message}</span>
    </div>
    {action}
  </aside>
);

export const StatusBanner: React.FC = () => {
  const { connectionState, stateDetail, connect, settings, t } = useTerminal();

  if (connectionState === 'connected') {
    return null;
  }

  // If there's no token or pair code, let OnboardingView handle the guidance
  if (!settings.token && !settings.pairCode && connectionState === 'disconnected') {
    return null;
  }

  if (connectionState === 'connecting') {
    return (
      <Line
        tone="accent"
        glyph={<Spinner />}
        message={t('statusBanner.connecting')}
      />
    );
  }

  if (connectionState === 'reconnecting') {
    return (
      <Line
        tone="warn"
        glyph={<Spinner />}
        assertive
        message={stateDetail || t('statusBanner.reconnectingDefault')}
        action={
          <Button variant="warn" onClick={() => connect()} className="shrink-0">
            {t('statusBanner.reconnectNow')}
          </Button>
        }
      />
    );
  }

  if (connectionState === 'error') {
    return (
      <Line
        tone="bad"
        glyph={GLYPH.cross}
        assertive
        message={stateDetail || t('statusBanner.errorDefault')}
        action={
          <Button variant="danger" onClick={() => connect()} className="shrink-0">
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <Line
        tone="idle"
        glyph={GLYPH.off}
        message={t('statusBanner.disconnected')}
        action={
          <Button variant="primary" onClick={() => connect()} className="shrink-0">
            {t('common.connect')}
          </Button>
        }
      />
    );
  }

  return null;
};
