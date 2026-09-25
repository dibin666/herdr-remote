import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE_ROOT = path.join(__dirname, '..');

function runProbe(url, stateDir) {
  // The built module (`pretest` builds dist/), as the published TUI runs it.
  const apiPath = pathToFileURL(path.join(PACKAGE_ROOT, 'dist', 'tui', 'api.js')).href;
  const script = `
    import(${JSON.stringify(apiPath)}).then(async ({ probeRelay }) => {
      const result = await probeRelay({ relay: { mode: 'remote', remoteUrl: ${JSON.stringify(url)} } });
      process.stdout.write(JSON.stringify(result));
    }).catch((error) => {
      process.stderr.write(error.stack || String(error));
      process.exitCode = 1;
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HERDR_REMOTE_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `probe child exited with ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('probeRelay reports public liveness when scoped host status is unavailable', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-probe-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      hostId: request.headers['x-herdr-host-id'],
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, version: 'test-relay' }));
      return;
    }
    response.writeHead(401);
    response.end(
      JSON.stringify({ ok: false, code: 'auth_required', message: 'host is not enrolled' }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(() => {
    server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const result = await runProbe(url, stateDir);
  assert.deepEqual(result, { ok: true, version: 'test-relay' });
  assert.deepEqual(
    requests.map((request) => request.path),
    ['/healthz', '/api/status'],
  );
  assert.equal(requests[0].hostId, undefined, 'liveness must be public');
  assert.match(requests[1].hostId, /^host-/);
});
