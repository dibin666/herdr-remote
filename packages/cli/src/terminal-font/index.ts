/**
 * Reads the font the workstation's terminal draws with.
 *
 * Colors can be asked for with OSC queries (see terminal-palette.js); a font
 * cannot. No escape sequence that mainstream emulators answer reports the
 * family, so the host works out which terminal it is running in and reads that
 * terminal's own settings — the same settings dialog the user edited.
 *
 * The answer travels to the browser in `host_hello` as a family name, a size,
 * and the font files the browser may fetch by hash, so a phone draws the
 * session in the face the workstation shows even though it has no such font
 * installed. Nothing here guesses: a terminal this module does not know yields
 * `null`, and the browser keeps its own monospace stack.
 */

import fs from 'node:fs';
import {
  type HostTerminalFont,
  sanitizeTerminalFont,
  TERMINAL_FONT_CHUNK_BYTES,
} from 'herdr-remote-relay/protocol';
import { readRuntime, writeRuntime } from '../runtime.js';
import { type FontDeps, type FontSetting, withDefaults } from './deps.js';
import {
  concreteFamily,
  type LocalFontFace,
  type LocalSubsetSource,
  resolveFontFaces,
  resolveSubsetSources,
} from './files.js';
import { READERS } from './readers.js';
import {
  identifyTerminal,
  type ProcessEntry,
  processArguments,
  processLineage,
  terminalProcess,
} from './terminals.js';

/** A terminal's font as detected: which terminal, the family and its size. */
export interface DetectedFont {
  source: string | null;
  family: string;
  sizePx?: number;
}

/** The record a connector serves from: detection plus the local files. */
export type LocalTerminalFont = DetectedFont & {
  faces: LocalFontFace[];
  subsets: LocalSubsetSource[];
};

/** Reads one terminal's configured font: `{ source, family, sizePx }` or null. */
export function readTerminalFont(source: string, deps: FontDeps = {}): DetectedFont | null {
  const resolved = withDefaults(deps);
  const reader = READERS[source];
  if (!reader) return null;
  let font: FontSetting | null;
  try {
    font = reader(resolved);
  } catch {
    return null;
  }
  if (!font?.family) return null;
  const family = concreteFamily(font.family, resolved);
  if (!family) return null;
  return sanitizeDetected({ source, family, sizePx: font.sizePx });
}

/** Identifies the terminal and reads its font. */
export function detectTerminalFont({
  env = process.env,
  ancestry,
  lineage,
  deps = {},
}: {
  env?: NodeJS.ProcessEnv;
  ancestry?: string[];
  lineage?: ProcessEntry[];
  deps?: FontDeps;
} = {}): DetectedFont | null {
  const processes =
    lineage ||
    (ancestry ? ancestry.map((name) => ({ pid: 0, name })) : processLineage({ run: deps.run }));
  const source = identifyTerminal({ env, ancestry: processes.map((entry) => entry.name) });
  if (!source) return null;
  // A terminal configured on its command line (xterm's `-fa`) says so there.
  const emulator = terminalProcess(source, processes);
  const terminalArgs = deps.terminalArgs || (emulator?.pid ? processArguments(emulator.pid) : []);
  return readTerminalFont(source, { ...deps, env, terminalArgs });
}

/** What detection reports, before any files are attached. */
function sanitizeDetected(value: unknown): DetectedFont | null {
  const clean = sanitizeTerminalFont(value);
  if (!clean) return null;
  const detected: DetectedFont = { source: clean.source || null, family: clean.family };
  if (clean.sizePx) detected.sizePx = clean.sizePx;
  return detected;
}

/** The full record a connector serves from: detection plus local files. */
function describeTerminalFont(
  detected: DetectedFont | null | undefined,
  deps: FontDeps = {},
): LocalTerminalFont | null {
  if (!detected?.family) return null;
  const faces = resolveFontFaces(detected.family, deps);
  return { ...detected, faces, subsets: resolveSubsetSources(detected.family, faces, deps) };
}

/** The same record with the file paths removed: what may leave this machine. */
export function publicTerminalFont(record: unknown): HostTerminalFont | null {
  return record ? sanitizeTerminalFont(record) : null;
}

/**
 * One slice of a face, by hash. The file is re-checked against what was
 * announced, so an edited font is refused rather than spliced into a browser's
 * copy of the old one.
 */
export function readFontChunk(
  record: { faces?: LocalFontFace[] } | null | undefined,
  sha256: string,
  index: number,
): { data: Buffer; total: number } | null {
  const face = record?.faces?.find((candidate) => candidate.sha256 === sha256);
  if (!face) return null;
  const total = Math.ceil(face.bytes / TERMINAL_FONT_CHUNK_BYTES);
  if (!Number.isInteger(index) || index < 0 || index >= total) return null;
  let fd: number | undefined;
  try {
    const stat = fs.statSync(face.path);
    if (stat.size !== face.bytes || stat.mtimeMs !== face.mtimeMs) return null;
    fd = fs.openSync(face.path, 'r');
    const start = index * TERMINAL_FONT_CHUNK_BYTES;
    const length = Math.min(TERMINAL_FONT_CHUNK_BYTES, face.bytes - start);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    if (read !== length) return null;
    return { data: buffer, total };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a read-only descriptor cannot lose data.
      }
  }
}

/** Reads a font a parent process already detected. */
export function fontFromEnvironment(env: NodeJS.ProcessEnv = process.env): DetectedFont | null {
  const raw = env.HERDR_TERM_FONT_JSON;
  if (!raw) return null;
  try {
    return sanitizeDetected(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remembers the font for a start that has no terminal around it: a service
 * manager's, or Herdr's detached server's.
 */
function rememberTerminalFont(detected: unknown): DetectedFont | null {
  const clean = sanitizeDetected(detected);
  if (!clean) return null;
  try {
    const state = readRuntime();
    const previous = state.terminalFont;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(clean)) {
      writeRuntime({ ...state, terminalFont: clean });
    }
  } catch {
    // A font is a nicety; failing to remember it must not break a start.
  }
  return clean;
}

function rememberedTerminalFont(): DetectedFont | null {
  try {
    return sanitizeDetected(readRuntime().terminalFont);
  } catch {
    return null;
  }
}

/**
 * Detect the terminal's font at the entry point, where the terminal's
 * variables and process ancestry are still this process's own, and hand the
 * answer to everything this command starts.
 */
export function captureTerminalFont({
  env = process.env,
  detect = detectTerminalFont as (options: { env: NodeJS.ProcessEnv }) => DetectedFont | null,
} = {}): DetectedFont | null {
  if (env.HERDR_TERM_FONT_JSON) return fontFromEnvironment(env);
  const detected = detect({ env });
  if (!detected) return null;
  env.HERDR_TERM_FONT_JSON = JSON.stringify(detected);
  rememberTerminalFont(detected);
  return detected;
}

/** The font a service start hands its children: inherited, else remembered. */
export function resolveHostFont({ env = process.env } = {}): DetectedFont | null {
  return fontFromEnvironment(env) || rememberedTerminalFont();
}

/**
 * What the connector serves: the terminal's settings read again now, when the
 * terminal is known, so a font changed since the last start is not reported
 * stale; otherwise what was handed down. `refresh` also re-identifies a
 * terminal nobody had named, for a browser that asks to sync.
 */
export function loadHostTerminalFont({
  env = process.env,
  refresh = false,
  deps = {},
}: {
  env?: NodeJS.ProcessEnv;
  refresh?: boolean;
  deps?: FontDeps;
} = {}): LocalTerminalFont | null {
  const known = resolveHostFont({ env });
  let current = known?.source ? readTerminalFont(known.source, { ...deps, env }) : null;
  if (!current && refresh && !known) current = detectTerminalFont({ env, deps });
  if (current && JSON.stringify(current) !== JSON.stringify(known)) rememberTerminalFont(current);
  return describeTerminalFont(current || known, deps);
}
