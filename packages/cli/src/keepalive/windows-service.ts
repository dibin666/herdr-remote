import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, PACKAGE_ROOT, stateDir } from '../paths.js';
import { cliEntryPoint, serviceEnvironment } from './environment.js';
import { escapeXml } from './launchd.js';
import type { KeepaliveBackend } from './types.js';

const DEFAULT_STATE_TIMEOUT_MS = 20_000;

const STATE_POLL_INTERVAL_MS = 250;

type WindowsServiceState = 'Started' | 'Stopped' | 'NonExistent';

export type ScCommandResult = { code: number | null; stdout: string; stderr: string };

type ScriptOptions = { nodePath: string; entryPoint: string };

type WinswConfigOptions = ScriptOptions & {
  id: string;
  user: string;
  domain: string;
  userSid: string;
  workingDirectory: string;
  environment: Record<string, string>;
};

/** The service name is machine-wide, so include the account to isolate each user's service. */
export function serviceId(username: string): string {
  return `herdr-remote-${username.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function currentServiceAccount(): { domain: string; user: string } {
  return {
    domain: process.env.USERDOMAIN || '',
    user: process.env.USERNAME || os.userInfo().username,
  };
}

/** Keep WinSW outside the npm package so updates do not touch a running executable. */
export function windowsServicePaths() {
  const id = serviceId(currentServiceAccount().user);
  const directory = path.join(stateDir(), 'service');
  return {
    id,
    directory,
    exePath: path.join(directory, `${id}.exe`),
    unitPath: path.join(directory, `${id}.xml`),
  };
}

function lastNonemptyLine(output: string): string | undefined {
  return output.trim().split(/\r?\n/).pop()?.trim();
}

export function parseWhoamiSid(output: string): string | null {
  const sid = lastNonemptyLine(output)?.match(/"([^"]+)"\s*$/)?.[1];
  return sid && /^S-\d(?:-\d+)+$/.test(sid) ? sid : null;
}

export function parseWinswState(output: string): WindowsServiceState {
  const state = lastNonemptyLine(output);
  return state === 'Started' || state === 'Stopped' || state === 'NonExistent'
    ? state
    : 'NonExistent';
}

export function windowsServiceSddl(userSid: string): string {
  // SYSTEM, Administrators, interactive users and service users keep the default service DACL.
  // The last ACE lets ordinary plugin hooks and the TUI start or stop this user's service.
  const accessEntries = [
    '(A;;CCLCSWRPWPDTLOCRRC;;;SY)',
    '(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)',
    '(A;;CCLCSWLOCRRC;;;IU)',
    '(A;;CCLCSWLOCRRC;;;SU)',
    `(A;;CCLCSWRPWPDTLOCRRC;;;${userSid})`,
  ];
  return 'D:' + accessEntries.join('');
}

export function renderWinswConfig(options: WinswConfigOptions): string {
  const { id, user, domain, userSid, nodePath, entryPoint, workingDirectory, environment } =
    options;
  const environmentLines = Object.entries(environment).map(
    ([key, value]) => `  <env name="${escapeXml(key)}" value="${escapeXml(value)}"/>`,
  );
  // Children write their own logs; WinSW captures the supervisor in supervisor.out.log.
  return `<service>
  <id>${escapeXml(id)}</id>
  <name>${escapeXml(`Herdr Remote (${user})`)}</name>
  <description>${escapeXml(`Browser access to Herdr workspaces, running as ${domain}\\${user}.`)}</description>
  <executable>${escapeXml(nodePath)}</executable>
  <arguments>${escapeXml(`"${entryPoint}" run --daemon`)}</arguments>
  <workingdirectory>${escapeXml(workingDirectory)}</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <onfailure action="restart" delay="3 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>${escapeXml(workingDirectory)}</logpath>
  <logname>supervisor</logname>
  <log mode="append"/>
${environmentLines.join('\n')}
  <serviceaccount>
    <domain>${escapeXml(domain)}</domain>
    <user>${escapeXml(user)}</user>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
  <securityDescriptor>${escapeXml(windowsServiceSddl(userSid))}</securityDescriptor>
</service>
`;
}

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function renderElevationScript({ nodePath, entryPoint }: ScriptOptions): string {
  const executable = escapePowerShellSingleQuoted(nodePath);
  const scriptPath = escapePowerShellSingleQuoted(entryPoint);
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath '${executable}' -ArgumentList '"${scriptPath}" keepalive install --elevated' -Verb RunAs -Wait -PassThru
} catch {
  exit 1223
}
exit $process.ExitCode`;
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function text(value: string | Buffer | null | undefined): string {
  return value ? String(value).trim() : '';
}

function runSc(command: 'start' | 'stop'): ScCommandResult {
  const result = spawnSync('sc.exe', [command, windowsServicePaths().id], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: result.status, stdout: text(result.stdout), stderr: text(result.stderr) };
}

function scFailure(command: 'start' | 'stop', result: ScCommandResult): Error {
  const output = result.stdout || result.stderr;
  return new Error(`sc.exe ${command} failed (${result.code}): ${output}`);
}

/** sc.exe returns Win32 codes: 1056 means already running and 1069 means service logon failed. */
export function classifyStartResult(result: ScCommandResult): 'ok' | 'logon-failed' | Error {
  if (result.code === 0 || result.code === 1056) return 'ok';
  if (result.code === 1069) return 'logon-failed';
  return scFailure('start', result);
}

export function startService(): ScCommandResult {
  return runSc('start');
}

export function stopService(): ScCommandResult {
  return runSc('stop');
}

export function serviceState(): WindowsServiceState {
  const { exePath } = windowsServicePaths();
  if (!fs.existsSync(exePath)) return 'NonExistent';
  const result = spawnSync(exePath, ['status'], { encoding: 'utf8', windowsHide: true });
  return result.error || result.status !== 0 ? 'NonExistent' : parseWinswState(text(result.stdout));
}

export function waitForState(
  target: WindowsServiceState,
  timeoutMs = DEFAULT_STATE_TIMEOUT_MS,
): void {
  const deadlineMs = Date.now() + timeoutMs;
  while (serviceState() !== target) {
    if (Date.now() >= deadlineMs)
      throw new Error(`Windows service did not reach ${target} within ${timeoutMs} ms`);
    // Lifecycle start/restart is synchronous, so this wait must not yield to an event loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_POLL_INTERVAL_MS);
  }
}

function stop(): void {
  const result = stopService();
  if (result.code !== 0 && result.code !== 1062 && result.code !== 1060)
    throw scFailure('stop', result);
}

function start(): { ok: true } {
  const commandResult = startService();
  const result = classifyStartResult(commandResult);
  if (result === 'logon-failed') {
    const output = commandResult.stdout || commandResult.stderr;
    throw new Error(`Windows service logon failed (1069): ${output}`);
  }
  if (result instanceof Error) throw result;
  return { ok: true };
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function prepare() {
  const paths = windowsServicePaths();
  await fs.promises.mkdir(paths.directory, { recursive: true });
  const source = path.join(PACKAGE_ROOT, 'vendor', 'winsw', 'WinSW.NET461.exe');
  if (!fs.existsSync(paths.exePath) || sha256(paths.exePath) !== sha256(source)) {
    try {
      await fs.promises.copyFile(source, paths.exePath);
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || ''))
        throw error;
      throw new Error(`Could not replace ${paths.exePath}; stop the Windows service first.`, {
        cause: error,
      });
    }
  }

  // A service may not receive reliable APPDATA, so pin both canonical directories.
  const environment = {
    ...serviceEnvironment(),
    HERDR_REMOTE_CONFIG_DIR: configDir(),
    HERDR_REMOTE_STATE_DIR: stateDir(),
    HERDR_REMOTE_SERVICE: '1',
  };
  const result = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const userSid = !result.error && result.status === 0 ? parseWhoamiSid(text(result.stdout)) : null;
  if (!userSid)
    throw new Error(`Could not read the current Windows user SID: ${text(result.stderr)}`);
  const { user, domain } = currentServiceAccount();
  await fs.promises.writeFile(
    paths.unitPath,
    renderWinswConfig({
      id: paths.id,
      user,
      domain,
      userSid,
      nodePath: process.execPath,
      entryPoint: cliEntryPoint(),
      workingDirectory: stateDir(),
      environment,
    }),
    'utf8',
  );
  return paths;
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** The password is entered only in the elevated console, so wait for that window to finish. */
async function install() {
  const paths = await prepare();
  const script = renderElevationScript({ nodePath: process.execPath, entryPoint: cliEntryPoint() });
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)],
    { windowsHide: true, stdio: 'ignore' },
  );
  const exitCode = await waitForChild(child);
  if (exitCode === 1223) {
    const error = new Error(
      'Administrator rights were not granted; nothing was installed.',
    ) as Error & { code: string };
    error.code = 'ELEVATION_CANCELLED';
    throw error;
  }
  if (exitCode !== 0)
    throw new Error(`Windows service installation did not complete (exit code ${exitCode}).`);
  return { ok: true as const, unitPath: paths.unitPath, state: serviceState() };
}

function status() {
  const paths = windowsServicePaths();
  const state = serviceState();
  const installed = state !== 'NonExistent';
  return {
    manager: 'windows-service' as const,
    installed,
    active: state === 'Started',
    enabled: installed,
    unitPath: paths.unitPath,
    state,
  };
}

/** WinSW requests elevation itself, so stopping first avoids a second UAC prompt. */
async function uninstall() {
  const paths = windowsServicePaths();
  stop();
  waitForState('Stopped');
  const result = spawnSync(paths.exePath, ['uninstall'], { windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(
      `WinSW uninstall failed with exit code ${String(result.status)}: ${text(result.stdout)}`,
    );
  if (serviceState() !== 'NonExistent')
    throw new Error(`Windows service still exists: ${paths.id}`);
  fs.rmSync(paths.directory, { recursive: true, force: true });
  return { ok: true as const, unitPath: paths.unitPath };
}

function restart() {
  stop();
  waitForState('Stopped');
  return start();
}

function logsHint(): string {
  return `Get-Content -Wait -Tail 40 "${path.join(stateDir(), 'supervisor.out.log')}"`;
}

export const windowsService: KeepaliveBackend = {
  name: 'windows-service',
  status,
  install,
  uninstall,
  restart,
  stop,
  logsHint,
};
