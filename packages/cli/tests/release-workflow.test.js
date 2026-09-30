import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { tempDir } from './helpers.js';

const scripts = path.resolve('.github/scripts');
const run = (cwd, command, args = [], env = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

function repository(t) {
  const directory = tempDir(t);
  const remote = path.join(directory, 'remote.git');
  const cwd = path.join(directory, 'work');
  run(directory, 'git', ['init', '--bare', remote]);
  run(directory, 'git', ['clone', remote, cwd]);
  run(cwd, 'git', ['checkout', '-b', 'master']);
  run(cwd, 'git', ['config', 'user.name', 'Release test']);
  run(cwd, 'git', ['config', 'user.email', 'release@example.invalid']);
  for (const name of ['cli', 'relay']) {
    fs.mkdirSync(path.join(cwd, 'packages', name), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages', name, 'package.json'), '{"version":"1.0.0"}\n');
  }
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(cwd, 'packages/cli/herdr-plugin.toml'), 'version = "1.0.0"\n');
  run(cwd, 'git', ['add', '.']);
  run(cwd, 'git', ['commit', '-m', 'Initial']);
  run(cwd, 'git', ['push', 'origin', 'master']);
  const base = run(cwd, 'git', ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'packages/cli/package.json'), '{"version":"1.0.1"}\n');
  const output = path.join(directory, 'output');
  return { cwd, remote, base, output };
}

test('release packer can be executed from a fresh checkout', () => {
  assert.match(
    run(path.resolve('.'), 'git', ['ls-files', '--stage', '.github/scripts/pack-release.sh']),
    /^100755 /,
  );
});

test('a newer master prevents recording stale artifacts', (t) => {
  const { cwd, remote, base, output } = repository(t);
  const other = path.join(tempDir(t), 'other');
  run(path.dirname(other), 'git', ['clone', remote, other]);
  run(other, 'git', [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Newer code',
  ]);
  run(other, 'git', ['push', 'origin', 'master']);
  const tip = run(other, 'git', ['rev-parse', 'HEAD']);
  run(cwd, 'bash', [path.join(scripts, 'record-release.sh')], {
    RELEASE_BASE: base,
    GITHUB_OUTPUT: output,
    RELAY_RELEASED: 'false',
  });
  assert.match(fs.readFileSync(output, 'utf8'), /recorded=false/);
  assert.equal(run(cwd, 'git', ['ls-remote', 'origin', 'refs/heads/master']).split('\t')[0], tip);
  assert.equal(run(cwd, 'git', ['ls-remote', '--tags', 'origin']), '');
});

test('recording atomically pushes a reachable release tag and can resume it', (t) => {
  const { cwd, base, output } = repository(t);
  run(cwd, 'bash', [path.join(scripts, 'record-release.sh')], {
    RELEASE_BASE: base,
    GITHUB_OUTPUT: output,
    RELAY_RELEASED: 'false',
  });
  assert.match(fs.readFileSync(output, 'utf8'), /recorded=true/);
  const head = run(cwd, 'git', ['rev-parse', 'HEAD']);
  assert.equal(run(cwd, 'git', ['rev-parse', 'herdr-remote-v1.0.1^{}']), head);
  const bin = tempDir(t);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 });
  fs.writeFileSync(output, '');
  run(cwd, 'bash', [path.join(scripts, 'resume-release.sh')], {
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_OUTPUT: output,
  });
  assert.match(fs.readFileSync(output, 'utf8'), /resume=true/);
  assert.match(fs.readFileSync(output, 'utf8'), /cli=true/);
});

test('assets are uploaded before a draft is made latest', (t) => {
  const cwd = tempDir(t);
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(cwd, 'dist/release'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'dist/release/latest.json'), '{}');
  const log = path.join(cwd, 'calls');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> "$CALL_LOG"\nif [ "$2" = view ]; then exit 1; fi\n`,
    { mode: 0o755 },
  );
  run(cwd, 'bash', [path.join(scripts, 'publish-release.sh'), '1.0.1', '1.0.0'], {
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: log,
  });
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /create .*--draft/);
  assert.ok(calls.indexOf('upload ') < calls.indexOf('edit '));
  assert.match(calls, /edit .*--draft=false --latest/);
});

test('an upload failure leaves the release private until a later successful retry', (t) => {
  const cwd = tempDir(t);
  fs.mkdirSync(path.join(cwd, 'dist/release'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'dist/release/latest.json'), '{}');
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
  echo "$*" >> "$CALL_LOG"
  if [ "$2" = view ]; then echo true; fi
  if [ "$2" = upload ]; then exit 1; fi
`,
    { mode: 0o755 },
  );
  const log = path.join(cwd, 'calls');
  const result = spawnSync('bash', [path.join(scripts, 'publish-release.sh'), '1.0.1', '1.0.0'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log },
  });
  assert.equal(result.status, 1);
  const calls = fs.readFileSync(log, 'utf8');
  assert.equal(calls.match(/upload /g).length, 5);
  assert.doesNotMatch(calls, /edit /);
});

test('an atomic push rejected by a concurrent merge publishes no tags', (t) => {
  const { cwd, remote, base, output } = repository(t);
  const other = path.join(tempDir(t), 'other');
  run(path.dirname(other), 'git', ['clone', remote, other]);
  run(other, 'git', [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Concurrent merge',
  ]);
  fs.writeFileSync(
    path.join(cwd, '.git/hooks/pre-push'),
    '#!/bin/sh\ngit -C "$CONCURRENT_REPO" push origin master\n',
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [path.join(scripts, 'record-release.sh')], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_BASE: base,
      GITHUB_OUTPUT: output,
      RELAY_RELEASED: 'false',
      CONCURRENT_REPO: other,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(run(cwd, 'git', ['ls-remote', '--tags', 'origin']), '');
  assert.ok(!fs.existsSync(output) || !fs.readFileSync(output, 'utf8').includes('recorded=true'));
});

test('published releases are not resumed and source lookup failures stop planning', (t) => {
  const { cwd, base, output } = repository(t);
  run(cwd, 'bash', [path.join(scripts, 'record-release.sh')], {
    RELEASE_BASE: base,
    GITHUB_OUTPUT: output,
    RELAY_RELEASED: 'false',
  });
  const bin = tempDir(t);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\necho \'[{"tagName":"herdr-remote-v1.0.1","isDraft":false}]\'\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(output, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output };
  run(cwd, 'bash', [path.join(scripts, 'resume-release.sh')], env);
  assert.equal(fs.readFileSync(output, 'utf8').trim(), 'resume=false');
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(output, '');
  const result = spawnSync('bash', [path.join(scripts, 'resume-release.sh')], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
});
