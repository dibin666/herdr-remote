// `herdr-remote admin-shell`: the administrator terminal inside a Herdr tab.
//
// This process runs in the tab's pane with the pane's standard rights and
// relays its console to an elevated PowerShell that the admin broker runs. On
// Windows, Node's raw mode reads keys as VT input and writes VT output through
// unchanged, so the relay is byte for byte.

import { requestHerdr } from '../herdr-api.js';
import type { Translate } from '../i18n/index.js';
import { ADMIN_TAB_ENV } from './admin-tab.js';
import { ElevatedPty } from './elevatedPty.js';

const BROKER_UNAVAILABLE_CODES = ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT'];

/** Close the pane this runs in, which closes the tab `openAdminTab` made for it. */
async function closeOwnPane(): Promise<void> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env[ADMIN_TAB_ENV] !== '1' || !socketPath || !paneId) return;
  try {
    await requestHerdr(socketPath, 'pane.close', { pane_id: paneId });
  } catch {
    // The shell's prompt comes back instead; the user can close the tab.
  }
}

export async function runAdminShell(t: Translate): Promise<number> {
  const { stdin, stdout } = process;
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));
  if (!stdin.isTTY || !stdout.isTTY) throw new Error(t('adminShell.needsTerminal'));
  const pty = new ElevatedPty({
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile'],
    cwd: process.cwd(),
  });
  const relayInput = (data: Buffer) => pty.write(data);
  const relayResize = () => pty.resize(stdout.columns, stdout.rows);
  stdin.setRawMode(true);
  stdin.on('data', relayInput);
  stdout.on('resize', relayResize);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      pty.start({
        cols: stdout.columns,
        rows: stdout.rows,
        onData: (data) => stdout.write(data),
        onExit: (event) => resolve(event.exitCode),
        onError: reject,
      });
    });
    await closeOwnPane();
    return exitCode;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code && BROKER_UNAVAILABLE_CODES.includes(code))
      throw new Error(t('adminShell.brokerUnavailable'));
    throw error;
  } finally {
    stdin.off('data', relayInput);
    stdout.off('resize', relayResize);
    stdin.setRawMode(false);
    stdin.pause();
  }
}
