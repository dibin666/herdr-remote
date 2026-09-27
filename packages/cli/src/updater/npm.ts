import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

type SpawnOptionsLike = { timeout: number; windowsHide: boolean; shell?: boolean };
export type SpawnLike = {
  (command: string, args: string[], options: SpawnOptionsLike): ChildProcess;
  (command: string, options: SpawnOptionsLike): ChildProcess;
};

type NpmInvocation =
  | { command: string; args: string[]; shell?: false }
  | { command: string; args?: never; shell: true };

/**
 * After the CVE-2024-27980 fix, spawning `.cmd` without a shell returns EINVAL;
 * npm-cli.js lets the current Node process run npm without a shell.
 */
export function npmInvocation({
  args,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  exists = fs.existsSync,
}: {
  args: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (filePath: string) => boolean;
}): NpmInvocation {
  if (platform !== 'win32') return { command: 'npm', args };

  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /npm-cli\.js$/i.test(npmExecPath) && exists(npmExecPath)) {
    return { command: execPath, args: [npmExecPath, ...args] };
  }

  const adjacentNpmCli = path.join(
    path.dirname(execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (exists(adjacentNpmCli)) return { command: execPath, args: [adjacentNpmCli, ...args] };

  return {
    command: ['npm.cmd', ...args.map((arg) => `"${arg}"`)].join(' '),
    shell: true,
  };
}

export interface NpmRun {
  ok: boolean;
  output: string;
  spawnFailed?: boolean;
}

export function runNpm(spawnImpl: SpawnLike, args: string[], timeoutMs: number): Promise<NpmRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const invocation = npmInvocation({ args });
      const options = {
        timeout: timeoutMs,
        windowsHide: true,
        ...(invocation.shell ? { shell: true } : {}),
      };
      child = invocation.args
        ? spawnImpl(invocation.command, invocation.args, options)
        : spawnImpl(invocation.command, options);
    } catch (error) {
      resolve({
        ok: false,
        spawnFailed: true,
        output: String((error as Error | undefined)?.message || error),
      });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (result: NpmRun) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const collect = (chunk: Buffer | string) => {
      output += String(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => finish({ ok: false, spawnFailed: true, output: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, output: output.trim() }));
  });
}
