import { useConnection, useSettings } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { CAP_BASE } from './caps';
import { KeyIcon } from './KeyLabel';

export function AdminTerminalButton({ squareKeyClass }: { squareKeyClass: string }) {
  const { platform, adminTerminalSupported, adapter } = useConnection();
  const { t } = useSettings();
  if (platform !== 'win32') return null;
  const supported = adminTerminalSupported !== false;

  return (
    <button
      type="button"
      data-testid="new-admin-terminal"
      // The host opens the tab in Herdr and focuses it there; this window's
      // terminal shows it, and nothing opens in the browser.
      onClick={() => adapter?.sendAdminTabOpen()}
      disabled={!supported}
      className={cn(
        CAP_BASE,
        squareKeyClass,
        'border-amber-500/50 bg-amber-500/10 text-amber-200 hover:border-amber-400 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50',
      )}
      title={t(supported ? 'terminal.adminTerminalSetup' : 'terminal.adminTerminalUpdate')}
      aria-label={t('terminal.newAdminTerminal')}
    >
      <KeyIcon name="admin" />
    </button>
  );
}
