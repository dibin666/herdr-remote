#!/usr/bin/env node
'use strict';

// Standalone entry point for the Herdr Remote relay.
//
// This binary has no knowledge of the herdr-remote plugin: it can be installed
// and run on its own host (`npm i -g herdr-remote-relay`) with nothing but
// environment variables for configuration.

const fs = require('node:fs');
const path = require('node:path');
const { loadRelayConfig, PACKAGE_ROOT } = require('../src/relay-config');
const { RelayServer, VERSION, PROTOCOL_VERSION } = require('../src/relay-server');

const USAGE = `herdr-remote-relay ${VERSION} — standalone relay for Herdr Remote

Usage: herdr-remote-relay [options]

Options:
  --password <password>      Password a workstation must present (RELAY_PASSWORD).
                             Leave unset for a public relay.
  --admin-token <token>      Operator token for the relay dashboard (RELAY_ADMIN_TOKEN).
  --deployment-mode <mode>   WebUI deployment mode: local or remote (default remote).
  --public-url <url>         Public URL browsers use (RELAY_PUBLIC_URL)
  --bind <address>           Listen address (default 127.0.0.1, RELAY_BIND)
  --port <number>            Listen port (default 8787, RELAY_PORT)
  --trust-proxy              Read X-Forwarded-For for rate limiting (RELAY_TRUST_PROXY)
  --state-file <file>        Where device/host records are stored (RELAY_AUTH_STATE_FILE)
  --allowed-origins <list>   Extra comma-separated browser origins (RELAY_ALLOWED_ORIGINS)
  --max-clients <number>     Max browsers per workstation (RELAY_MAX_CLIENTS_PER_HOST)
  --config <file>            JSON config file (also HERDR_RELAY_CONFIG)
  -h, --help                 Show this help
  -v, --version              Show the version

See docs/self-hosted-relay.md.
`;

function webUiBuilt() {
  return fs.existsSync(path.join(PACKAGE_ROOT, 'web', 'dist', 'index.html'));
}

async function main(argv = process.argv.slice(2)) {
  let loaded;
  try {
    loaded = loadRelayConfig({ argv });
  } catch (error) {
    process.stderr.write(`herdr-remote-relay: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { config, help, version, errors, warnings, configFile } = loaded;

  if (help) {
    process.stdout.write(USAGE);
    return;
  }
  if (version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (errors.length > 0) {
    for (const message of errors) process.stderr.write(`herdr-remote-relay: ${message}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const server = new RelayServer(config);
  let address;
  try {
    address = await server.listen(config.relay.port, config.relay.host);
  } catch (error) {
    const hint = error.code === 'EADDRINUSE'
      ? ` (port ${config.relay.port} is already in use)`
      : error.code === 'EACCES'
        ? ` (no permission to bind port ${config.relay.port})`
        : '';
    process.stderr.write(`herdr-remote-relay: failed to listen${hint}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`herdr-remote-relay ${VERSION} (protocol ${PROTOCOL_VERSION})\n`);
  process.stdout.write(`  listening   http://${config.relay.host}:${address.port}\n`);
  process.stdout.write(`  public url  ${config.relay.publicUrl}\n`);
  process.stdout.write(`  password    ${config.auth.password ? 'set' : 'not set (public relay)'}\n`);
  process.stdout.write(`  admin       ${config.auth.adminToken ? 'set (/admin)' : 'not configured'}\n`);
  process.stdout.write(`  state file  ${server.stateFile}\n`);
  if (configFile) process.stdout.write(`  config file ${configFile}\n`);
  if (!webUiBuilt()) {
    process.stdout.write('  web ui      NOT BUILT (run "npm run build" in this package)\n');
  }
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);

  let closing = false;
  const stop = (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`herdr-remote-relay: ${signal} received, shutting down\n`);
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`herdr-remote-relay: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, USAGE };
