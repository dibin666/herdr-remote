// An administrator terminal as a tab of the workstation's own Herdr, opened at
// a browser's request.
//
// Herdr's API cannot start a tab running a command of our choosing, so the tab
// starts with the user's shell and `herdr-remote admin-shell` is typed into it
// once that shell is running. Nor can the API focus a tab for one client:
// `tab.focus` moves every client attached to this Herdr, which is the price of
// the requesting window showing the new tab at once.

import path from 'node:path';
import { requestHerdr } from '../herdr-api.js';
import { createTranslator, detectLocale } from '../i18n/index.js';
import { cliEntryPoint } from '../keepalive/environment.js';
import { adminBrokerStatus } from './admin-broker.js';

const SHELL_START_TIMEOUT_MS = 5_000;
const SHELL_START_POLL_MS = 100;
/** Marks the tab's shell, so `admin-shell` knows it may close the pane when done. */
export const ADMIN_TAB_ENV = 'HERDR_REMOTE_ADMIN_TAB';

interface TabCreated {
  tab: { tab_id: string };
  root_pane: { pane_id: string };
}

interface PaneProcesses {
  process_info?: { foreground_processes?: { name?: string }[] };
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command line that starts `admin-shell`, in the syntax of the tab's shell. */
export function adminShellCommand(shell: string, node: string, entry: string): string {
  const name = path.win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') {
    return `& ${powershellQuote(node)} ${powershellQuote(entry)} admin-shell`;
  }
  if (name === 'cmd') return `"${node}" "${entry}" admin-shell`;
  // Git Bash and other POSIX shells: forward slashes, or C:\ reads as escapes.
  const posix = (file: string) => posixQuote(file.replaceAll('\\', '/'));
  return `${posix(node)} ${posix(entry)} admin-shell`;
}

/** The new tab's shell, once Herdr reports it running. */
async function waitForShell(
  request: typeof requestHerdr,
  socketPath: string,
  paneId: string,
): Promise<string> {
  const deadline = Date.now() + SHELL_START_TIMEOUT_MS;
  while (true) {
    const info = await request<PaneProcesses>(socketPath, 'pane.process_info', {
      pane_id: paneId,
    });
    const shell = info.process_info?.foreground_processes?.[0]?.name;
    if (shell) return shell;
    if (Date.now() >= deadline) throw new Error('The new tab did not start a shell in time.');
    await new Promise((resolve) => setTimeout(resolve, SHELL_START_POLL_MS));
  }
}

export async function openAdminTab({
  socketPath,
  label,
  request = requestHerdr,
  brokerReady = adminBrokerStatus,
}: {
  socketPath: string;
  label: string;
  request?: typeof requestHerdr;
  brokerReady?: () => Promise<boolean>;
}): Promise<void> {
  if (!(await brokerReady())) {
    throw Object.assign(new Error('The administrator terminal broker is not running.'), {
      code: 'admin_broker_unavailable',
    });
  }
  const created = await request<TabCreated>(socketPath, 'tab.create', {
    label,
    focus: false,
    env: { [ADMIN_TAB_ENV]: '1' },
  });
  const paneId = created.root_pane.pane_id;
  await request(socketPath, 'tab.focus', { tab_id: created.tab.tab_id });
  const shell = await waitForShell(request, socketPath, paneId);
  await request(socketPath, 'pane.send_input', {
    pane_id: paneId,
    text: adminShellCommand(shell, process.execPath, cliEntryPoint()),
    keys: ['enter'],
  });
}

/** Open the tab for a browser window, and tell that window when it could not. */
export async function openAdminTabFor(
  streamId: string | null,
  options: { socketPath: string; language?: string; send: (payload: unknown) => void },
): Promise<void> {
  const t = createTranslator(detectLocale({ preference: options.language }));
  try {
    await openAdminTab({ socketPath: options.socketPath, label: t('adminShell.tabLabel') });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    process.stderr.write(`herdr-remote host connector: could not open an admin tab: ${message}\n`);
    options.send({
      type: 'error',
      clientId: streamId,
      code: code === 'admin_broker_unavailable' ? code : 'admin_tab_failed',
      message,
    });
  }
}
