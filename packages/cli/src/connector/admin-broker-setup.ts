import { spawn } from 'node:child_process';
import { cliEntryPoint } from '../keepalive/environment.js';
import {
  encodePowerShellCommand,
  escapePowerShellSingleQuoted,
} from '../keepalive/windows-service.js';

type Action = 'install' | 'uninstall';
type Translator = (key: string, values?: Record<string, string | number>) => string;

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export function renderAdminBrokerElevationScript({
  action,
  nodePath,
  entryPoint,
}: {
  action: Action;
  nodePath: string;
  entryPoint: string;
}): string {
  const quote = escapePowerShellSingleQuoted;
  const args = `"${entryPoint}" admin-broker ${action} --elevated`;
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath '${quote(nodePath)}' -ArgumentList '${quote(args)}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden
} catch {
  if (($_.Exception.HResult -band 65535) -eq 1223) { exit 1223 }
  exit 1
}
exit $process.ExitCode`;
}

function elevatedErrorCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Register the per-user task from the Windows TUI, requesting elevation once. */
export async function configureAdminBroker(action: Action, t: Translator): Promise<void> {
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));

  const script = renderAdminBrokerElevationScript({
    action,
    nodePath: process.execPath,
    entryPoint: cliEntryPoint(),
  });
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
    { windowsHide: true, stdio: 'ignore' },
  );
  const exitCode = await waitForChild(child);
  if (exitCode === 1223)
    throw elevatedErrorCode(t('adminBroker.elevationCancelled'), 'ELEVATION_CANCELLED');
  if (exitCode !== 0) throw new Error(t('adminBroker.setupFailed'));
}
