// The file list dialog's own logic: what to ask for, and how to order the
// answer. Nothing here touches the socket or the DOM, so it can be tested in
// one place.

import type { FsListEntry } from '@protocol/files';

export type FsSortKey = 'name' | 'size' | 'mtime';
export type FsSortDir = 'asc' | 'desc';

/** A request id the relay's `FS_REQUEST_ID` allows: 16 url-safe characters. */
export function newFsRequestId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Directories group first; inside each group the chosen key orders. Names are
 * the tiebreaker everywhere, so a sorted listing never shuffles between views.
 */
export function sortFsEntries(
  entries: FsListEntry[],
  key: FsSortKey,
  dir: FsSortDir,
): FsListEntry[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    let cmp = 0;
    if (key === 'name') cmp = a.name.localeCompare(b.name);
    else if (key === 'size') cmp = a.size - b.size;
    else cmp = a.mtimeMs - b.mtimeMs;
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * factor;
  });
}

/**
 * The parent of a listed path, or null at a root. The host does the real
 * `path.dirname`; this only decides whether the `..` row shows. Handles
 * `/`-joined POSIX paths and `C:\` Windows roots.
 */
export function parentDirOf(cwd: string): string | null {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return null;
  if (cut === 0) return '/';
  // 'C:\foo' loses its root without the separator kept.
  if (cut === 2 && trimmed[1] === ':') return `${trimmed.slice(0, 3)}`;
  return trimmed.slice(0, cut);
}

/** `2024-05-01 14:32` — compact, and the same in every browser locale. */
export function formatFsTime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '—';
  const d = new Date(mtimeMs);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Extensions a file may have and still be worth offering a preview for —
 * text and code. Not a verdict: the host reads the file and a binary answer
 * is still reported as not text.
 */
const PREVIEW_EXTENSIONS = new Set([
  'asm',
  'bash',
  'bat',
  'bib',
  'c',
  'cfg',
  'clj',
  'cmake',
  'conf',
  'config',
  'cpp',
  'cs',
  'css',
  'csv',
  'cue',
  'cxx',
  'dart',
  'diff',
  'dockerfile',
  'editorconfig',
  'el',
  'env',
  'erl',
  'ex',
  'exs',
  'fish',
  'fs',
  'gitattributes',
  'gitignore',
  'go',
  'gradle',
  'groovy',
  'h',
  'hh',
  'hpp',
  'hs',
  'htm',
  'html',
  'ini',
  'ipynb',
  'java',
  'jl',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'lisp',
  'lock',
  'log',
  'lua',
  'm',
  'markdown',
  'md',
  'mjs',
  'mk',
  'ml',
  'mm',
  'nim',
  'nix',
  'npmrc',
  'nvmrc',
  'patch',
  'php',
  'pl',
  'plist',
  'pm',
  'po',
  'properties',
  'ps1',
  'py',
  'r',
  'rb',
  'rs',
  'rst',
  's',
  'scala',
  'scss',
  'sh',
  'sql',
  'srt',
  'svelte',
  'svg',
  'swift',
  'tcl',
  'tex',
  'text',
  'textproto',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vim',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

/**
 * Whether the menu offers a preview for `name`: a text-like extension, a
 * dotfile (`.env`, `.bashrc` — almost always config text), or no extension at
 * all (`Makefile`, `LICENSE`).
 */
export function isPreviewableName(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return true;
  return PREVIEW_EXTENSIONS.has(lower.slice(dot + 1));
}

/** Hand the assembled bytes to the browser's download shelf. */
export function saveBlobAs(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
