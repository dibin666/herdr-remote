// The keys that put this workstation's Herdr into prefix mode. A browser has
// to tell a Herdr command from typed text, and only Herdr's own config file
// says which key starts one, so the host reads it and reports it in its hello.

import fs from 'node:fs';
import { sanitizeHerdrPrefixKeys } from 'herdr-remote-relay/protocol';
import { herdrConfigPath } from '../socket-discovery.js';
import { parseTomlSubset } from '../terminal-font/formats.js';

/** What Herdr uses when `keys.prefix` is absent or names nothing it can read. */
const DEFAULT_PREFIX_KEYS = ['ctrl+b'];

/**
 * `keys.prefix` from the Herdr config the connector's Herdr reads: one key or
 * a list, each a combo like `ctrl+space`. Always at least one key, because
 * Herdr itself falls back to `ctrl+b` when the file, the key or every entry
 * is unusable.
 */
export function readHerdrPrefixKeys(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  let text: string;
  try {
    text = fs.readFileSync(herdrConfigPath(env, platform), 'utf8');
  } catch {
    // No readable config file means Herdr runs on its defaults.
    return [...DEFAULT_PREFIX_KEYS];
  }
  const configured = parseTomlSubset(text)['keys.prefix'];
  const entries = typeof configured === 'string' ? [configured] : configured;
  return sanitizeHerdrPrefixKeys(entries) ?? [...DEFAULT_PREFIX_KEYS];
}
