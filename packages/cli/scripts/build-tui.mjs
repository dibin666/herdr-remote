#!/usr/bin/env node
// Bundles the Ink TUI into dist/tui.js.
//
// Only first-party code is bundled; ink, react and the rest stay external and
// resolve from node_modules at runtime, so the published package ships one
// small artifact rather than a copy of its dependency tree.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  logLevel: 'info',
  metafile: true,
});

const output = Object.entries(result.metafile.outputs)[0];
if (output) {
  process.stdout.write(
    `herdr-remote: built ${path.relative(packageRoot, output[0])} (${(output[1].bytes / 1024).toFixed(1)} kB)\n`,
  );
}
