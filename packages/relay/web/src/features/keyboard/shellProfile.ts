import type { HostShellProfile } from '@protocol/messages';

/** Shell families whose built-in editing shortcuts differ on the key bar. */
export type ShellProfile = HostShellProfile;

export function defaultShellProfile(
  platform?: string,
  reportedProfile?: HostShellProfile,
): ShellProfile {
  if (reportedProfile) return reportedProfile;
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** Detect the prompt from the last parsed rows of Herdr's composed terminal. */
export function detectShellProfile(
  lines: readonly string[],
  platform?: string,
): ShellProfile | null {
  if (platform !== 'win32') return platform ? 'posix' : null;
  for (const line of lines.slice(-8).reverse()) {
    if (/\b(?:MINGW32|MINGW64|MSYS)\b/i.test(line)) return 'git-bash';
    if (/^\s*PS\s+[a-z]:\\[^>]*>/i.test(line)) return 'powershell';
    if (/^\s*(?:[a-z]:\\[^>]*|\\\\[^\\]+\\[^>]+)>/i.test(line)) return 'cmd';
  }
  return null;
}

export function quickCommands(profile: ShellProfile): string[] {
  if (profile === 'cmd') return ['dir', 'cls', 'git status', 'cd', 'tasklist', 'exit', 'type'];
  if (profile === 'powershell')
    return [
      'Get-ChildItem',
      'Clear-Host',
      'git status',
      'Get-Location',
      'Get-Process',
      'exit',
      'Get-Content',
    ];
  return ['ls -la', 'clear', 'git status', 'pwd', 'top', 'exit', 'cat'];
}
