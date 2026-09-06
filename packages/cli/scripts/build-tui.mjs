#!/usr/bin/env node
// Bundles the Ink TUI into dist/tui.js.
//
// Only first-party code is bundled; ink, react and the rest stay external and
// resolve from node_modules at runtime, so the published package ships one
// small artifact rather than a copy of its dependency tree.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { cjsBanner } from './cjs-banner.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

const result = await build({
  entryPoints: [path.join(packageRoot, 'tui', 'src', 'index.tsx')],
  outfile: path.join(packageRoot, 'dist', 'tui.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  jsx: 'automatic',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: cjsBanner },
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
  logLevel: 'info',
  metafile: true,
});

const output = Object.entries(result.metafile.outputs)[0];
if (output) {
  process.stdout.write(`herdr-remote: built ${path.relative(packageRoot, output[0])} (${(output[1].bytes / 1024).toFixed(1)} kB)\n`);
}
