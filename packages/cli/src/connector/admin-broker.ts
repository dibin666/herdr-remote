import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Translate } from '../i18n/index.js';
import { PtySession } from '../pty-session.js';
import { stateDir } from '../paths.js';
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
const BROKER_TASK_END_TIMEOUT_MS = 10_000;
/** Time for a stopping broker's goodbye to reach the caller before the process ends. */
const BROKER_EXIT_GRACE_MS = 1_000;

type PtySpawn = typeof import('node-pty').spawn;

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

/** Registers and starts the broker's logon task; run elevated. */
export function adminBrokerTaskScript(): string {
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
  // Not PACKAGE_ROOT: npm updates the package by renaming its directory, and
  // Windows refuses while it is the working directory of this long-lived task.
  return `
$ErrorActionPreference = 'Stop'
$taskName = ${powershellQuote(adminBrokerTaskName())}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${powershellQuote(powershell)} -Argument ${powershellQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedBrokerCommand}`)} -WorkingDirectory ${powershellQuote(stateDir())}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
`;
}

export function installAdminBroker(t: Translate): void {
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));
  // The task cannot start in a working directory that does not exist yet.
  fs.mkdirSync(stateDir(), { recursive: true });
  runPowerShell(adminBrokerTaskScript(), t);
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

/** Send the broker one request and read the type of its one reply, or null without one. */
function requestAdminBroker(type: 'ping' | 'shutdown'): Promise<string | null> {
  let broker: ReturnType<typeof connectAdminBroker>;
  try {
    broker = connectAdminBroker();
  } catch {
    return Promise.resolve(null);
  }
  const { socket, token } = broker;
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const finish = (reply: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };
    socket.setTimeout(BROKER_PING_TIMEOUT_MS, () => finish(null));
    socket.setEncoding('utf8');
    socket.on('connect', () => sendAdminBrokerMessage(socket, { type, token }));
    socket.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(String(JSON.parse(response.slice(0, newline)).type));
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
  });
}

export async function adminBrokerStatus(): Promise<boolean> {
  return (await requestAdminBroker('ping')) === 'pong';
}

/**
 * Ask the broker to exit so its task can start it on a new release. It stays
 * while an administrator terminal is open: that terminal may be the one asking.
 * A broker from before this request answers neither way.
 */
export async function stopAdminBroker(): Promise<'stopped' | 'busy' | 'unavailable'> {
  const reply = await requestAdminBroker('shutdown');
  return reply === 'bye' ? 'stopped' : reply === 'busy' ? 'busy' : 'unavailable';
}

/** Start the broker's task now, which the account that registered it may do unelevated. */
export function startAdminBrokerTask(t: Translate): void {
  if (process.platform !== 'win32') throw new Error(t('adminBroker.windowsOnly'));
  runPowerShell(
    `
$ErrorActionPreference = 'Stop'
$taskName = ${powershellQuote(adminBrokerTaskName())}
# A broker that was just stopped may still be ending, and IgnoreNew drops a start until it has.
$deadline = [DateTime]::UtcNow.AddMilliseconds(${BROKER_TASK_END_TIMEOUT_MS})
while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds ${BROKER_START_POLL_MS} }
Start-ScheduledTask -TaskName $taskName
`,
    t,
  );
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

function startBrokerPty(
  socket: net.Socket,
  message: BrokerMessage,
  spawn: PtySpawn | undefined,
): PtySession {
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
    spawn,
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
export function serveAdminBroker({
  spawn,
  onShutdown = () => {},
}: {
  /** Starts the PowerShell; tests have none to start. */
  spawn?: PtySpawn;
  onShutdown?: () => void;
} = {}): net.Server {
  let token = '';
  const sessions = new Set<PtySession>();
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
          if (message.type === 'shutdown') {
            const busy = sessions.size > 0;
            sendAdminBrokerMessage(socket, { type: busy ? 'busy' : 'bye' });
            socket.end();
            if (!busy) {
              server.close();
              onShutdown();
            }
            return;
          }
          if (message.type !== 'start') {
            writeError(socket, new Error('Expected an administrator terminal start request.'));
            return;
          }
          try {
            pty = startBrokerPty(socket, message, spawn);
            sessions.add(pty);
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
    const release = () => {
      if (!pty) return;
      pty.kill();
      sessions.delete(pty);
    };
    socket.on('close', release);
    socket.on('error', release);
  });
  listenAdminBroker(server, (port) => {
    token = publishAdminBrokerEndpoint(port);
  });
  return server;
}

function runAdminBroker(): void {
  if (process.platform !== 'win32')
    throw new Error('Administrator PTYs are only supported on Windows.');
  serveAdminBroker({
    onShutdown: () => setTimeout(() => process.exit(0), BROKER_EXIT_GRACE_MS).unref(),
  }).on('error', (error) => {
    process.stderr.write(`herdr-remote administrator broker: ${error.message}\n`);
  });
}

if (path.basename(process.argv[1] || '') === 'admin-broker.js') runAdminBroker();
