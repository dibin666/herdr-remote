import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Translate } from '../i18n/index.js';
import { PtySession } from '../pty-session.js';
import { PACKAGE_ROOT, stateDir } from '../paths.js';
import {
  ADMIN_BROKER_MAX_MESSAGE_BYTES,
  adminBrokerTaskName,
  adminBrokerTokenMatches,
  connectAdminBroker,
  listenAdminBroker,
  publishAdminBrokerEndpoint,
  sendAdminBrokerMessage,
} from './adminBrokerEndpoint.js';

const BROKER_PING_TIMEOUT_MS = 1_000;
const BROKER_START_TIMEOUT_MS = 5_000;
const BROKER_START_POLL_MS = 250;

interface BrokerMessage extends Record<string, unknown> {
  type?: string;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string, t: Translate): void {
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 15_000,
      },
    );
  } catch {
    throw new Error(t('adminBroker.needsElevation'));
  }
}

export function installAdminBroker(t: Translate): void {
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));
  const brokerPath = fileURLToPath(import.meta.url);
  // Pinned so the broker publishes its endpoint where this install's callers look.
  const brokerCommand = `$env:HERDR_REMOTE_STATE_DIR = ${powershellQuote(stateDir())}; & ${powershellQuote(process.execPath)} ${powershellQuote(brokerPath)}`;
  const encodedBrokerCommand = Buffer.from(brokerCommand, 'utf16le').toString('base64');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = `
$ErrorActionPreference = 'Stop'
$taskName = ${powershellQuote(adminBrokerTaskName())}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${powershellQuote(powershell)} -Argument ${powershellQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedBrokerCommand}`)} -WorkingDirectory ${powershellQuote(PACKAGE_ROOT)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
`;
  runPowerShell(script, t);
}

export function uninstallAdminBroker(t: Translate): void {
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));
  runPowerShell(
    `
$ErrorActionPreference = 'Stop'
$taskName = ${powershellQuote(adminBrokerTaskName())}
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
`,
    t,
  );
}

export function adminBrokerStatus(): Promise<boolean> {
  let broker: ReturnType<typeof connectAdminBroker>;
  try {
    broker = connectAdminBroker();
  } catch {
    return Promise.resolve(false);
  }
  const { socket, token } = broker;
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(BROKER_PING_TIMEOUT_MS, () => finish(false));
    socket.setEncoding('utf8');
    socket.on('connect', () => sendAdminBrokerMessage(socket, { type: 'ping', token }));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\n')) finish(response.includes('"type":"pong"'));
    });
    socket.on('error', () => finish(false));
  });
}

/** The task starts the broker a moment after it is registered; wait for it to answer. */
export async function waitForAdminBroker(): Promise<boolean> {
  const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
  while (!(await adminBrokerStatus())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, BROKER_START_POLL_MS));
  }
  return true;
}

function writeError(socket: net.Socket, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendAdminBrokerMessage(socket, { type: 'error', message });
  socket.end();
}

function startBrokerPty(socket: net.Socket, message: BrokerMessage): PtySession {
  if (typeof message.command !== 'string' || !message.command || message.command.length > 4096)
    throw new Error('Invalid administrator terminal command.');
  if (path.basename(message.command).toLowerCase() !== 'powershell.exe')
    throw new Error('The administrator broker only starts PowerShell.');
  if (
    !Array.isArray(message.args) ||
    message.args.length > 128 ||
    !message.args.every((arg) => typeof arg === 'string')
  )
    throw new Error('Invalid administrator terminal arguments.');
  if (
    message.args.length !== 2 ||
    message.args[0] !== '-NoLogo' ||
    message.args[1] !== '-NoProfile'
  )
    throw new Error('The administrator broker only starts an interactive PowerShell prompt.');
  if (typeof message.cwd !== 'string' || message.cwd.length > 4096)
    throw new Error('Invalid administrator terminal working directory.');
  if (message.socketPath !== null && message.socketPath !== undefined)
    throw new Error('An administrator PowerShell session does not use a Herdr socket.');
  const pty = new PtySession({
    command: message.command,
    args: message.args as string[],
    cwd: message.cwd,
    socketPath: message.socketPath as string | null | undefined,
    platform: 'win32',
    // A plain PowerShell prompt does not need the Herdr UI's Kitty or mouse modes.
    fastWindowsPty: true,
  });
  pty.start({
    cols: PtySession.clampDimension(message.cols, PtySession.DEFAULT_COLS),
    rows: PtySession.clampDimension(message.rows, PtySession.DEFAULT_ROWS),
    onData: (data) => {
      if (socket.writable)
        sendAdminBrokerMessage(socket, {
          type: 'data',
          dataBase64: Buffer.from(data).toString('base64'),
        });
    },
    onExit: ({ exitCode, signal }) => {
      if (socket.writable) sendAdminBrokerMessage(socket, { type: 'exit', exitCode, signal });
      socket.end();
    },
  });
  sendAdminBrokerMessage(socket, { type: 'started', pid: pty.terminal?.pid ?? 0 });
  return pty;
}

/** Listen on loopback and publish the endpoint; every request must carry its token. */
export function serveAdminBroker(): net.Server {
  let token = '';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let pending = '';
    let pty: PtySession | null = null;
    let firstMessage = true;
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending, 'utf8') > ADMIN_BROKER_MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('Administrator terminal message exceeded the limit.'));
        return;
      }
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message: BrokerMessage;
        try {
          message = JSON.parse(line);
        } catch {
          writeError(socket, new Error('Invalid administrator terminal message.'));
          return;
        }
        if (firstMessage) {
          firstMessage = false;
          if (!adminBrokerTokenMatches(token, message.token)) {
            writeError(socket, new Error('Administrator terminal request was not authorized.'));
            return;
          }
          if (message.type === 'ping') {
            sendAdminBrokerMessage(socket, { type: 'pong' });
            socket.end();
            return;
          }
          if (message.type !== 'start') {
            writeError(socket, new Error('Expected an administrator terminal start request.'));
            return;
          }
          try {
            pty = startBrokerPty(socket, message);
          } catch (error) {
            writeError(socket, error);
            return;
          }
          continue;
        }
        if (!pty) return;
        if (message.type === 'input' && typeof message.dataBase64 === 'string') {
          if (message.dataBase64.length <= ADMIN_BROKER_MAX_MESSAGE_BYTES)
            pty.write(Buffer.from(message.dataBase64, 'base64'));
        } else if (message.type === 'resize') {
          pty.resize(message.cols, message.rows);
        } else if (message.type === 'kill') {
          pty.kill();
          socket.end();
          return;
        }
      }
    });
    socket.on('close', () => pty?.kill());
    socket.on('error', () => pty?.kill());
  });
  listenAdminBroker(server, (port) => {
    token = publishAdminBrokerEndpoint(port);
  });
  return server;
}

function runAdminBroker(): void {
  if (process.platform !== 'win32')
    throw new Error('Administrator PTYs are only supported on Windows.');
  serveAdminBroker().on('error', (error) => {
    process.stderr.write(`herdr-remote administrator broker: ${error.message}\n`);
  });
}

if (path.basename(process.argv[1] || '') === 'admin-broker.js') runAdminBroker();
