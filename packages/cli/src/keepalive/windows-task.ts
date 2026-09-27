import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, stateDir } from '../paths.js';
import { detachedLogsHint } from './detached.js';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import {
  currentServiceAccount,
  encodePowerShellCommand,
  escapePowerShellSingleQuoted,
  serviceId,
  windowsService,
} from './windows-service.js';
import type { KeepaliveBackend, KeepaliveStatus } from './types.js';

const TASK_START_TIMEOUT_MS = 15_000;
const TASK_STOP_TIMEOUT_MS = 15_000;
const TASK_POLL_INTERVAL_MS = 250;

type WindowsTaskState = 'Absent' | 'Ready' | 'Queued' | 'Running' | 'Disabled';

type TaskLaunchOptions = {
  nodePath: string;
  entryPoint: string;
  workingDirectory: string;
  configDirectory: string;
  stateDirectory: string;
  environment: Record<string, string>;
};

type TaskRegistrationOptions = {
  taskName: string;
  account: string;
  powershellPath: string;
  workingDirectory: string;
  launchScript: string;
};

export function windowsTaskName(username = currentServiceAccount().user): string {
  return serviceId(username);
}

export function renderWindowsTaskLaunchScript(options: TaskLaunchOptions): string {
  const environment = {
    ...options.environment,
    HERDR_REMOTE_CONFIG_DIR: options.configDirectory,
    HERDR_REMOTE_STATE_DIR: options.stateDirectory,
    HERDR_REMOTE_SERVICE: '1',
  };
  const environmentLines = Object.entries(environment).map(
    ([key, value]) => `$env:${key} = '${escapePowerShellSingleQuoted(value)}'`,
  );

  return `$ErrorActionPreference = 'Stop'
${environmentLines.join('\n')}
Set-Location -LiteralPath '${escapePowerShellSingleQuoted(options.workingDirectory)}'
& '${escapePowerShellSingleQuoted(options.nodePath)}' '${escapePowerShellSingleQuoted(options.entryPoint)}' run --daemon
exit $LASTEXITCODE`;
}

export function renderWindowsTaskRegistrationScript(options: TaskRegistrationOptions): string {
  const taskName = escapePowerShellSingleQuoted(options.taskName);
  const account = escapePowerShellSingleQuoted(options.account);
  const powershellPath = escapePowerShellSingleQuoted(options.powershellPath);
  const workingDirectory = escapePowerShellSingleQuoted(options.workingDirectory);
  const launchArguments = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodePowerShellCommand(options.launchScript)}`;

  return `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '${powershellPath}' -Argument '${launchArguments}' -WorkingDirectory '${workingDirectory}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User '${account}'
# Interactive logon uses the signed-in token and avoids storing account credentials.
$principal = New-ScheduledTaskPrincipal -UserId '${account}' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${taskName}' -Description 'Herdr Remote keep-alive' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Enable-ScheduledTask -TaskName '${taskName}' | Out-Null
Start-ScheduledTask -TaskName '${taskName}'`;
}

export function parseWindowsTaskState(output: string): WindowsTaskState {
  try {
    const state = (JSON.parse(output.replace(/^\uFEFF/, '').trim()) as { State?: unknown }).State;
    return state === 'Ready' || state === 'Queued' || state === 'Running' || state === 'Disabled'
      ? state
      : 'Absent';
  } catch {
    // Task status is best-effort; malformed scheduler output means no known task.
    return 'Absent';
  }
}

function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function taskStateScript(taskName: string): string {
  const safeName = escapePowerShellSingleQuoted(taskName);
  return `$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue
if ($null -eq $task) { '{"State":"Absent"}'; exit 0 }
[pscustomobject]@{ State = [string]$task.State } | ConvertTo-Json -Compress`;
}

function invokePowerShell(script: string, label: string): string {
  const result = spawnSync(
    windowsPowerShellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(script),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    const output = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${label} failed (${String(result.status)}): ${output}`);
  }
  return String(result.stdout || '').trim();
}

function taskState(): WindowsTaskState {
  const result = spawnSync(
    windowsPowerShellPath(),
    [
      '-NoProfile',
      '-NoLogo',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(taskStateScript(windowsTaskName())),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    // A status query must not make unrelated CLI commands fail on an unavailable scheduler.
    return 'Absent';
  }
  return parseWindowsTaskState(String(result.stdout || ''));
}

function accountName(): string {
  const { domain, user } = currentServiceAccount();
  return domain ? `${domain}\\${user}` : user;
}

function stopTaskScript(taskName: string): string {
  const safeName = escapePowerShellSingleQuoted(taskName);
  return `$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue
if ($null -eq $task -or ($task.State -ne 'Running' -and $task.State -ne 'Queued')) { exit 0 }
Stop-ScheduledTask -TaskName '${safeName}'
$deadline = [DateTime]::UtcNow.AddMilliseconds(${TASK_STOP_TIMEOUT_MS})
do {
  Start-Sleep -Milliseconds ${TASK_POLL_INTERVAL_MS}
  $task = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue
} while ($task -and ($task.State -eq 'Running' -or $task.State -eq 'Queued') -and [DateTime]::UtcNow -lt $deadline)
if ($task -and ($task.State -eq 'Running' -or $task.State -eq 'Queued')) { throw 'Scheduled task did not stop in time.' }`;
}

function stopTask(): void {
  const state = taskState();
  if (state === 'Running' || state === 'Queued')
    invokePowerShell(stopTaskScript(windowsTaskName()), 'Stopping the Windows scheduled task');
}

function launchOptions(): TaskLaunchOptions {
  const workingDirectory = stateDir();
  return {
    nodePath: process.execPath,
    entryPoint: cliEntryPoint(),
    workingDirectory,
    configDirectory: configDir(),
    stateDirectory: workingDirectory,
    environment: serviceEnvironment(),
  };
}

function status(): KeepaliveStatus {
  const state = taskState();
  const installed = state !== 'Absent';
  return {
    manager: 'windows-task',
    installed,
    active: state === 'Running',
    enabled: installed && state !== 'Disabled',
    state: state.toLowerCase(),
  };
}

async function install() {
  if (taskState() !== 'Absent') stopTask();
  // Remove the earlier service before starting a second supervisor for this user.
  if (windowsService.status().installed) await windowsService.uninstall();

  const options = launchOptions();
  await fs.promises.mkdir(options.workingDirectory, { recursive: true });
  const launchScript = renderWindowsTaskLaunchScript(options);
  const script = renderWindowsTaskRegistrationScript({
    taskName: windowsTaskName(),
    account: accountName(),
    powershellPath: windowsPowerShellPath(),
    workingDirectory: options.workingDirectory,
    launchScript,
  });
  invokePowerShell(script, 'Installing the Windows scheduled task');
  const deadline = Date.now() + TASK_START_TIMEOUT_MS;
  let state = taskState();
  while (state !== 'Running' && state !== 'Absent' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
    state = taskState();
  }
  if (state !== 'Running')
    throw new Error(`Windows scheduled task did not start (state: ${state.toLowerCase()}).`);
  return { ok: true as const, taskName: windowsTaskName(), state };
}

async function uninstall() {
  const name = windowsTaskName();
  if (taskState() !== 'Absent') {
    stopTask();
    const safeName = escapePowerShellSingleQuoted(name);
    invokePowerShell(
      `Unregister-ScheduledTask -TaskName '${safeName}' -Confirm:$false -ErrorAction Stop`,
      'Removing the Windows scheduled task',
    );
  }
  if (windowsService.status().installed) await windowsService.uninstall();
  return { ok: true as const, taskName: name };
}

function restart() {
  stopTask();
  const safeName = escapePowerShellSingleQuoted(windowsTaskName());
  invokePowerShell(
    `Start-ScheduledTask -TaskName '${safeName}'`,
    'Starting the Windows scheduled task',
  );
  return { ok: true as const };
}

export const windowsTask: KeepaliveBackend = {
  name: 'windows-task',
  status,
  install,
  uninstall,
  restart,
  stop: stopTask,
  logsHint: () => detachedLogsHint('win32'),
};
