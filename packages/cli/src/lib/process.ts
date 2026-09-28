import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PROCESS_QUERY_TIMEOUT_MS = 10_000;

// Records written before start tokens existed carry only a pid. Until none are
// left, such a record is trusted only while its process runs one of our entry
// points: the relay, the host connector or `herdr-remote run`.
const OUR_ENTRY_POINT = /herdr-remote-relay\.js|connector[\\/]main\.js|herdr-remote\.js"?\s+run\b/;

/** Runs a command and returns its stdout; injectable so each platform's parsing can be tested. */
type RunCommand = (command: string, args: string[]) => string;

/** What to read about each process: when it started, or its command line. */
type Detail = 'start' | 'command';

/** Whether `pid` names a running process, including one owned by another user. */
export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    // The same instant must print the same text whenever and wherever it is asked.
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  // The exit code is not trusted: ps and PowerShell fail when any one pid is
  // gone, yet still print the rest. A command that could not run prints nothing.
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** `<pid> <value>` lines, as ps and our PowerShell queries print them. */
function parsePidLines(output: string): Map<number, string> {
  const details = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match) details.set(Number(match[1]), match[2]);
  }
  return details;
}

function linuxDetails(pids: number[], detail: Detail, run: RunCommand): Map<number, string> {
  let bootId = '';
  if (detail === 'start') {
    try {
      // Start times count clock ticks since boot, so they only identify a
      // process together with the boot they were counted in.
      bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      // A /proc without boot ids (some sandboxes) still has ps.
      return psDetails(pids, detail, run);
    }
  }
  const details = new Map<number, string>();
  for (const pid of pids) {
    let text: string;
    try {
      text = fs.readFileSync(`/proc/${pid}/${detail === 'start' ? 'stat' : 'cmdline'}`, 'utf8');
    } catch {
      // Not running, or hidden from us: either way it is not a process we can vouch for.
      continue;
    }
    if (detail === 'command') {
      details.set(pid, text.replaceAll('\0', ' ').trim());
      continue;
    }
    // The command name before this may itself contain spaces and parentheses;
    // after it, field 3 (state) comes first and field 22 is the start time.
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (fields[19]) details.set(pid, `${bootId}:${fields[19]}`);
  }
  return details;
}

function psDetails(pids: number[], detail: Detail, run: RunCommand): Map<number, string> {
  const column = detail === 'start' ? 'lstart' : 'command';
  return parsePidLines(run('ps', ['-o', `pid=,${column}=`, '-p', pids.join(',')]));
}

function windowsDetails(pids: number[], detail: Detail, run: RunCommand): Map<number, string> {
  const script =
    detail === 'start'
      ? // StartTime is empty for processes we may not inspect; those are not ours anyway.
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Where-Object StartTime | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`
      : `Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${pid}`).join(' OR ')}" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
  return parsePidLines(
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]),
  );
}

function processDetails(
  pids: number[],
  detail: Detail,
  platform: NodeJS.Platform,
  run: RunCommand,
): Map<number, string> {
  // Dead pids are the common case after a clean stop, and ruling them out here
  // saves spawning ps or PowerShell just to hear so.
  const candidates = [...new Set(pids)].filter(pidAlive);
  if (candidates.length === 0) return new Map();
  if (platform === 'linux') return linuxDetails(candidates, detail, run);
  if (platform === 'win32') return windowsDetails(candidates, detail, run);
  return psDetails(candidates, detail, run);
}

/**
 * When each running process in `pids` started, as opaque tokens; pids that are
 * not running, or that the system will not describe, are left out.
 *
 * A pid alone does not identify a process: the number goes to another process
 * once this one exits, and after a reboot the same boot-time services land on
 * the same numbers again. On Linux the number of a thread in another process
 * even passes `pidAlive`. Recorded next to its pid, this token only ever
 * matches the process it was read from.
 */
export function processStarts(
  pids: number[],
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
): Map<number, string> {
  return processDetails(pids, 'start', platform, run);
}

/** The command line of each running process in `pids`, which the system is willing to show. */
export function processCommands(
  pids: number[],
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
): Map<number, string> {
  return processDetails(pids, 'command', platform, run);
}

export function processStart(pid: number, platform = process.platform): string | null {
  return processStarts([pid], platform).get(pid) ?? null;
}

/** The records that still name the very process they were taken from. */
export function stillRunning<T extends { pid?: unknown; processStart?: unknown }>(
  records: T[],
): T[] {
  const pidsOf = (list: T[]) =>
    list.map((record) => record.pid).filter((pid) => Number.isInteger(pid)) as number[];
  const legacy = records.filter((record) => typeof record.processStart !== 'string');
  const starts = processStarts(pidsOf(records.filter((record) => !legacy.includes(record))));
  const commands = legacy.length > 0 ? processCommands(pidsOf(legacy)) : new Map();
  return records.filter((record) =>
    legacy.includes(record)
      ? // We only ever write start tokens, so a legacy record naming our own pid
        // was left by an earlier process that happened to have it.
        record.pid !== process.pid && OUR_ENTRY_POINT.test(commands.get(record.pid as number) ?? '')
      : starts.get(record.pid as number) === record.processStart,
  );
}
