import { describe, expect, it } from 'vitest';
import { defaultShellProfile, detectShellProfile, quickCommands } from './shellProfile';

describe('Windows shell profile detection', () => {
  it('uses the connector report first and falls back to PowerShell on Windows', () => {
    expect(defaultShellProfile('win32', 'git-bash')).toBe('git-bash');
    expect(defaultShellProfile('win32')).toBe('powershell');
    expect(defaultShellProfile('linux')).toBe('posix');
  });

  it('recognizes CMD, PowerShell and Git Bash prompts', () => {
    expect(detectShellProfile([String.raw`C:\Users\dibin>`], 'win32')).toBe('cmd');
    expect(detectShellProfile([String.raw`PS C:\Users\dibin>`], 'win32')).toBe('powershell');
    expect(detectShellProfile(['MINGW64 /c/Users/dibin'], 'win32')).toBe('git-bash');
    expect(detectShellProfile(['user@host ~>'], 'linux')).toBe('posix');
  });

  it('uses matching quick commands for the detected shell', () => {
    expect(quickCommands('cmd')).toContain('dir');
    expect(quickCommands('powershell')).toContain('Get-ChildItem');
    expect(quickCommands('git-bash')).toContain('ls -la');
  });
});
