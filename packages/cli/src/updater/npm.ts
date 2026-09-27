import type { ChildProcess } from 'node:child_process';

export type SpawnLike = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => ChildProcess;

export interface NpmRun {
  ok: boolean;
  output: string;
  spawnFailed?: boolean;
}

export function runNpm(spawnImpl: SpawnLike, args: string[], timeoutMs: number): Promise<NpmRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl('npm', args, { timeout: timeoutMs, windowsHide: true });
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
