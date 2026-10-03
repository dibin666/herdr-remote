#!/usr/bin/env node
// Turn the built workspaces into the trees that are released.
//
// The workspaces compile file by file with tsc, which suits development and
// the tests. A release ships something much smaller: every JavaScript
// dependency is bundled into a few minified files, so an install no longer
// downloads ink, react, ws and their dozens of transitive packages, and a
// self-update only has to swap our own files. node-pty is the one dependency
// left for npm, because it carries native code built per platform.
//
//   relay <out>   the standalone relay: one bundled entry point and the web UI.
//                 With --runtime, only what runs: the container image.
//   cli <out>     herdr-remote, with that relay tree under node_modules/ as a
//                 bundled dependency, so one install carries both.
//
// Run from the repository root after `npm run build` (the relay alone needs
// only `build:server` and the web build). The two packages are released
// together under one version.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELAY = path.join(ROOT, 'packages', 'relay');
const CLI = path.join(ROOT, 'packages', 'cli');

// Bundled CommonJS dependencies (ws, react, qrcode) `require` Node built-ins,
// which an ES module output cannot do without a real `require`.
const REQUIRE_SHIM =
  "import { createRequire as __herdrCreateRequire } from 'node:module';\nconst require = __herdrCreateRequire(import.meta.url);";

const COMMON = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  banner: { js: REQUIRE_SHIM },
  // React and its reconciler ship a development build that is several times
  // the size of the production one and only differs in diagnostics.
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

// Run by npm after it installs the release. node-pty's tarball carries Windows
// and macOS prebuilds for every architecture plus their debug symbols, about
// 58 MB, of which a machine can load at most one directory and no .pdb file.
// Only disk is at stake, so nothing here may fail the install.
const POSTINSTALL = `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
try {
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const prebuilds = path.join(root, 'prebuilds');
  const own = process.platform + '-' + process.arch;
  for (const name of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    const directory = path.join(prebuilds, name);
    if (name !== own) fs.rmSync(directory, { recursive: true, force: true });
    else
      for (const file of fs.readdirSync(directory, { recursive: true }))
        if (String(file).endsWith('.pdb')) fs.rmSync(path.join(directory, String(file)), { force: true });
  }
} catch (error) {
  process.stderr.write('herdr-remote: could not prune node-pty prebuilds: ' + error.message + '\\n');
}
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

/** The manifest fields a released package keeps from its workspace manifest. */
function publicManifest(source, fields) {
  const manifest = {};
  for (const field of [
    'name',
    'version',
    'description',
    'license',
    'type',
    'repository',
    'homepage',
    'bugs',
    'keywords',
    'engines',
    ...fields,
  ]) {
    if (source[field] !== undefined) manifest[field] = source[field];
  }
  return manifest;
}

/**
 * `runtime` leaves out what only a person installing the relay reads: the
 * READMEs, the example config and the deployment examples. The container image
 * and the copy inside herdr-remote want just the program.
 */
async function bundleRelay(out, { runtime = false, version } = {}) {
  const source = { ...readJson(path.join(RELAY, 'package.json')) };
  if (version) source.version = version;
  const webDist = path.join(RELAY, 'web', 'dist', 'index.html');
  if (!fs.existsSync(webDist))
    throw new Error('packages/relay/web/dist is missing; build it first');

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // One file: the relay finds its package root as the parent of its own
  // directory, so the entry point has to stay in bin/.
  await build({
    ...COMMON,
    entryPoints: [path.join(RELAY, 'bin', 'herdr-remote-relay.js')],
    outfile: path.join(out, 'bin', 'herdr-remote-relay.js'),
    // ws loads these native accelerators when they are installed and works
    // without them.
    external: ['bufferutil', 'utf-8-validate'],
  });
  fs.chmodSync(path.join(out, 'bin', 'herdr-remote-relay.js'), 0o755);
  copy(path.join(RELAY, 'web', 'dist'), path.join(out, 'web', 'dist'));
  const extras = ['README.md', 'README.zh-CN.md', 'config.example.json', 'deploy'];
  for (const file of ['LICENSE', ...(runtime ? [] : extras)])
    copy(path.join(RELAY, file), path.join(out, file));
  writeJson(path.join(out, 'package.json'), {
    ...publicManifest(source, ['bin']),
    files: ['bin', 'web/dist', ...(runtime ? [] : extras.filter((file) => file !== 'README.md'))],
  });
  return source.version;
}

async function bundleCli(out) {
  const source = readJson(path.join(CLI, 'package.json'));
  const relayVersion = readJson(path.join(RELAY, 'package.json')).version;
  // The release workflow bumps both to one version before packing; anywhere
  // else (a pull request's dry run) the relay inside is stamped with the CLI's.
  if (relayVersion !== source.version) {
    process.stderr.write(
      `warning: herdr-remote ${source.version} and herdr-remote-relay ${relayVersion} differ; the bundled relay is stamped ${source.version}\n`,
    );
  }
  const dist = path.join(CLI, 'dist');
  if (!fs.existsSync(path.join(dist, 'cli.js'))) throw new Error('packages/cli/dist is missing');

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // The entry points other processes are started from keep their paths:
  // service.ts starts dist/connector/main.js, and the Windows admin broker's
  // task runs dist/connector/admin-broker.js.
  await build({
    ...COMMON,
    entryPoints: ['cli.js', 'connector/main.js', 'connector/admin-broker.js'].map((entry) =>
      path.join(dist, entry),
    ),
    outbase: dist,
    outdir: path.join(out, 'dist'),
    splitting: true,
    chunkNames: 'chunks/[hash]',
    // node-pty is native and stays an installed dependency. Ink loads the
    // React devtools only under DEV=true, and they are not installed.
    external: ['node-pty', 'react-devtools-core'],
  });
  // font-subset.ts looks for the wasm beside the bundle before asking harfbuzzjs.
  copy(
    createRequire(path.join(CLI, 'package.json')).resolve('harfbuzzjs/dist/harfbuzz-subset.wasm'),
    path.join(out, 'dist', 'harfbuzz-subset.wasm'),
  );
  for (const file of [
    'bin',
    'vendor',
    'herdr-plugin.toml',
    'config.example.json',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
  ])
    copy(path.join(CLI, file), path.join(out, file));

  await bundleRelay(path.join(out, 'node_modules', 'herdr-remote-relay'), {
    runtime: true,
    version: source.version,
  });

  writeJson(path.join(out, 'package.json'), {
    ...publicManifest(source, ['bin']),
    files: ['bin', 'dist', 'vendor', 'herdr-plugin.toml', 'config.example.json', 'README.zh-CN.md'],
    dependencies: {
      'herdr-remote-relay': source.version,
      'node-pty': source.dependencies['node-pty'],
    },
    bundleDependencies: ['herdr-remote-relay'],
    scripts: { postinstall: 'node dist/postinstall.js' },
  });
  fs.writeFileSync(path.join(out, 'dist', 'postinstall.js'), POSTINSTALL);
  return source.version;
}

const [target, out, flag] = process.argv.slice(2);
if (!['relay', 'cli'].includes(target) || !out || (flag && flag !== '--runtime')) {
  process.stderr.write('usage: bundle-release.mjs relay <out-dir> [--runtime] | cli <out-dir>\n');
  process.exit(2);
}
const version =
  target === 'relay'
    ? await bundleRelay(path.resolve(out), { runtime: flag === '--runtime' })
    : await bundleCli(path.resolve(out));
process.stdout.write(`${target} ${version} -> ${path.resolve(out)}\n`);
