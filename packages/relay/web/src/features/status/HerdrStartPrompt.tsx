import type React from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { Button, Notice, Panel, Spinner } from '@/shared/ui';

/**
 * Herdr is not running on the paired workstation.
 *
 * Asked over the empty terminal rather than in a toast: without Herdr there is
 * nothing else this window can show, and a question that scrolls away leaves a
 * blank screen with no way forward. It names the workstation, because the
 * button starts something on a real machine and the user should see which one.
 */
export const HerdrStartPrompt: React.FC = () => {
  const { activeProfile, t } = useSettings();
  const { herdrLaunch, startHerdr, hostname } = useConnection();
  if (!herdrLaunch) return null;

  const host = hostname || activeProfile?.displayName || t('herdrLaunch.thisHost');
  const failed = herdrLaunch.phase === 'failed';

  return (
    <div
      data-testid="herdr-start-prompt"
      className="absolute inset-0 z-30 flex items-center justify-center bg-tui-crust/85 p-3"
    >
      <Panel
        title={failed ? t('herdrLaunch.failedTitle') : t('herdrLaunch.title')}
        tone={failed ? 'bad' : 'warn'}
        className="w-full max-w-md"
        bodyClassName="space-y-3"
        aria-label={t('herdrLaunch.title')}
      >
        {herdrLaunch.phase === 'starting' ? (
          <p className="flex items-center gap-2 text-tui-text" role="status">
            <Spinner />
            <span>{t('herdrLaunch.starting', { host })}</span>
          </p>
        ) : (
          <>
            <p className="leading-snug text-tui-text">{t('herdrLaunch.body', { host })}</p>
            {failed && herdrLaunch.message ? (
              <Notice tone="bad">
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-tui-sm">
                  {herdrLaunch.message}
                </pre>
              </Notice>
            ) : null}
            <p className="text-tui-sm leading-snug text-tui-faint">{t('herdrLaunch.scope')}</p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={startHerdr} autoFocus>
                {failed ? t('common.retry') : t('herdrLaunch.start')}
              </Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
};
