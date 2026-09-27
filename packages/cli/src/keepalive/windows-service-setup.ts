import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Translate } from '../i18n/index.js';
import {
  classifyStartResult,
  currentServiceAccount,
  encodePowerShellCommand,
  escapePowerShellSingleQuoted,
  startService,
  waitForState,
  windowsServicePaths,
  serviceState,
  windowsService,
} from './windows-service.js';

const MAX_PASSWORD_ATTEMPTS = 3;

type Account = { id: string; account: string };

export function renderSetServiceAccountScript({ id, account }: Account): string {
  const safeId = escapePowerShellSingleQuoted(id);
  const safeAccount = escapePowerShellSingleQuoted(account);
  return `$ErrorActionPreference = 'Stop'
$password = [Console]::In.ReadLine()
$service = Get-CimInstance -ClassName Win32_Service -Filter "Name='${safeId}'"
$result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ StartName = '${safeAccount}'; StartPassword = $password }
exit [int]$result.ReturnValue`;
}

function setServiceAccount(
  id: string,
  account: string,
  password: string,
): ReturnType<typeof spawnSync> {
  const script = renderSetServiceAccountScript({ id, account });
  // The password travels through stdin only; it is not part of PowerShell arguments or a file.
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
    { input: `${password}\n`, encoding: 'utf8', windowsHide: true },
  );
}

/** Read a password with `*` feedback and remove ESC sequences such as arrow keys. */
function promptSecret(prompt: string): Promise<string | null> {
  const input = process.stdin;
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let password = '';
    const finish = (value: string | null) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const clean = String(chunk).replace(
        /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|O.|.)/g,
        '',
      );
      for (const character of clean) {
        if (character === '\r' || character === '\n') return finish(password);
        if (character === '\u0003') return finish(null);
        if (character === '\u007f' || character === '\b') {
          if (password.length > 0) {
            password = Array.from(password).slice(0, -1).join('');
            process.stdout.write('\b \b');
          }
          continue;
        }
        const code = character.codePointAt(0) || 0;
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
        password += character;
        process.stdout.write('*');
      }
    };
    input.on('data', onData);
  });
}

function failure(label: string, result: ReturnType<typeof spawnSync>): Error {
  const output = String(result.stdout || result.stderr || '').trim();
  return new Error(`${label} failed (${String(result.status)}): ${output}`);
}

/** Complete service installation inside the elevated console. */
export async function completeServiceInstall(t: Translate): Promise<number> {
  try {
    const paths = windowsServicePaths();
    // A different elevated account resolves a different state directory
    // and cannot see the XML written before elevation.
    if (!fs.existsSync(paths.unitPath)) {
      process.stdout.write(`${t('keepalive.wrongAccount')}\n`);
      return 1;
    }
    if (serviceState() !== 'NonExistent') {
      windowsService.stop();
      waitForState('Stopped');
      const removed = spawnSync(paths.exePath, ['uninstall'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (removed.error || removed.status !== 0) throw failure('WinSW uninstall', removed);
    }

    const installed = spawnSync(paths.exePath, ['install'], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (installed.error || installed.status !== 0) throw failure('WinSW install', installed);

    const { domain, user } = currentServiceAccount();
    const account = `${domain}\\${user}`;
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      const password = await promptSecret(t('keepalive.passwordPrompt', { account }));
      if (password === null) return 1;
      const changed = setServiceAccount(paths.id, account, password);
      if (changed.error || changed.status !== 0)
        throw failure('Setting the Windows service account', changed);
      const started = classifyStartResult(startService());
      if (started === 'ok') {
        process.stdout.write(`${t('keepalive.serviceInstalled', { id: paths.id })}\n`);
        return 0;
      }
      if (started === 'logon-failed') {
        process.stdout.write(`${t('keepalive.passwordRejected')}\n`);
        continue;
      }
      process.stdout.write(`${started.message}\n`);
      return 1;
    }
    return 1;
  } catch (error) {
    process.stdout.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    process.stdout.write(`${t('keepalive.pressEnter')}\n`);
    process.stdin.resume();
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer | string) => {
        if (!/[\r\n]/.test(String(chunk))) return;
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve();
      };
      process.stdin.on('data', onData);
    });
  }
}
