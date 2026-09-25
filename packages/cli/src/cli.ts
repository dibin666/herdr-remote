// herdr-remote command line: argument parsing and the subcommands.
//
// With no arguments (and a real terminal) this opens the configuration TUI;
// the subcommands exist for scripting and for the actions declared in
// herdr-plugin.toml, which Herdr runs without a terminal attached.

import fs from 'node:fs';
import path from 'node:path';

import { LANGUAGES, loadConfig, migrateLegacyConfig } from './config.js';
import { PACKAGE_ROOT, configPath, stateDir } from './paths.js';
import { extractPairingCode } from './relay-client.js';
import { resolvePublicUrl } from './relay-urls.js';
import { type Translate, createTranslator, detectLocale } from './i18n/index.js';
import type { fullStatus } from './lifecycle.js';
import { preferredLanAddress } from './net-interfaces.js';

const VERSION = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version;

const USAGE = `herdr-remote ${VERSION} — browser access to Herdr workspaces

Usage: herdr-remote [command] [options]

Commands:
  (none)               Open the configuration TUI
  start                Start relay and host connector
  stop                 Stop services
  restart              Restart services
  status [--json]      Show service status
  pair [--json]        Create pairing code
  url                  Print browser access URL
  run [--daemon]       Run services in foreground (keep-alive)
  keepalive <action>   install | uninstall | restart | status
  plugin <action>      link | unlink | status  (Herdr plugin)

Options:
  --lang <zh|en>       Interface language
  --json               JSON output
  -h, --help           Show help
  -v, --version        Show version

Self-hosting: docs/self-hosted-relay.md
`;

/** Flags the command line understands; `unknown` is the last one it did not. */
export interface CliFlags {
  json?: boolean;
  daemon?: boolean;
  help?: boolean;
  version?: boolean;
  lang?: string;
  unknown?: string;
}

type FullStatus = Awaited<ReturnType<typeof fullStatus>>;

function parseArgs(argv: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--daemon') {
      flags.daemon = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg === '--lang') {
      flags.lang = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--lang=')) {
      flags.lang = arg.slice('--lang='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      flags.unknown = arg;
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function describeStatus(status: FullStatus, t: Translate): string {
  const lines: string[] = [];
  lines.push(`${t('overview.mode')}: ${t(`mode.${status.mode}`)}`);
  if (status.relay.local) {
    lines.push(
      `${t('overview.relay')}: ${status.relay.alive ? t('common.running') : t('common.stopped')} (${status.relay.bind}:${status.relay.port})`,
    );
  } else {
    lines.push(`${t('overview.relay')}: ${status.relay.remoteUrl}`);
  }
  lines.push(
    `${t('overview.host')}: ${status.host.alive ? t('common.running') : t('common.stopped')}`,
  );
  lines.push(
    `${t('overview.socket')}: ${status.host.socketPath}${status.host.socketExists ? '' : ` (${t('overview.socketMissing')})`}`,
  );
  lines.push(`${t('overview.webUrl')}: ${status.publicUrl}`);
  if (status.keepalive) {
    const state = status.keepalive.active
      ? t('common.running')
      : status.keepalive.installed
        ? t('common.installed')
        : t('common.notInstalled');
    lines.push(`${t('overview.keepalive')}: ${status.keepalive.manager} — ${state}`);
  }
  if (status.relay.health && status.relay.health.ok === false) {
    lines.push(
      `${t('overview.relay')}: ${t('overview.unreachable', { message: status.relay.health.message ?? '' })}`,
    );
  }
  return lines.join('\n');
}

async function runTui(options: { language: string | null }): Promise<void> {
  const { startTui } = await import('./tui/index.js');
  await startTui(options);
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || null;

  migrateLegacyConfig();

  // Ask the terminal for its colors while it is still a plain terminal: the
  // TUI takes the screen a few lines below, and the services this command
  // starts usually run detached with nothing to ask. Everything downstream
  // inherits the answer through the environment.
  (await import('./terminal-palette.js')).captureTerminalPalette();
  // The font, likewise, is read while this process still knows which terminal
  // it runs in: its variables and its parent process are gone once a service
  // manager or Herdr's detached server starts the connector.
  (await import('./terminal-font.js')).captureTerminalFont();

  const config = loadConfig();
  const preference =
    flags.lang && (LANGUAGES as readonly string[]).includes(flags.lang)
      ? flags.lang
      : config.ui.language;
  const t = createTranslator(detectLocale({ preference }));

  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // Loaded lazily so that `--help` and the TUI do not pay for loading the
  // service layer (which pulls in the relay package and node-pty).
  const lifecycle = await import('./lifecycle.js');
  const service = await import('./service.js');

  switch (command) {
    case null: {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runTui({ language: flags.lang || null });
        return;
      }
      // Herdr runs plugin panes and actions without a TTY; emit status instead
      // of trying to paint an interface into a pipe.
      printJson(await lifecycle.fullStatus(config));
      return;
    }
    case 'start': {
      const result = lifecycle.startAll(config);
      if (flags.json) printJson(result);
      else
        process.stdout.write(
          `${t('services.started')}\n${describeStatus(await lifecycle.fullStatus(config), t)}\n`,
        );
      return;
    }
    case 'stop': {
      const result = lifecycle.stopAll(config);
      if (flags.json) printJson(result);
      else process.stdout.write(`${t('services.stopped')}\n`);
      return;
    }
    case 'restart': {
      const result = lifecycle.restartAll(config);
      if (flags.json) printJson(result);
      else process.stdout.write(`${t('services.restarted')}\n`);
      return;
    }
    case 'status': {
      const status = await lifecycle.fullStatus(config);
      if (flags.json) printJson(status);
      else process.stdout.write(`${describeStatus(status, t)}\n`);
      return;
    }
    case 'pair': {
      const pairing = await service.pair();
      if (flags.json) {
        printJson(pairing);
        return;
      }
      const code = extractPairingCode(pairing);
      const url =
        pairing.pairUrl ||
        `${resolvePublicUrl(config, preferredLanAddress())}/?pairCode=${encodeURIComponent(code)}`;
      const minutes = `${Math.round((config.auth.pairingTtlMs || 600000) / 60000)}m`;
      process.stdout.write(
        `${t('pair.code')}: ${code}\n${t('pair.url')}: ${url}\n${t('pair.expires', { minutes, time: new Date(pairing.expiresAt).toLocaleTimeString() })}\n`,
      );
      return;
    }
    case 'url': {
      process.stdout.write(`${resolvePublicUrl(config, preferredLanAddress())}\n`);
      return;
    }
    case 'run': {
      const { runForeground } = await import('./supervisor.js');
      await runForeground({ logToFiles: Boolean(flags.daemon) });
      return;
    }
    case 'keepalive': {
      const keepalive = await import('./keepalive/index.js');
      const action = positional[1] || 'status';
      if (action === 'install') printJson(keepalive.install(config));
      else if (action === 'uninstall') printJson(keepalive.uninstall(config));
      else if (action === 'restart') printJson(keepalive.restart(config));
      else if (action === 'status') printJson(keepalive.status(config));
      else throw new Error(`unknown keepalive action: ${action}`);
      return;
    }
    case 'plugin': {
      const plugin = await import('./herdr-plugin.js');
      const action = positional[1] || 'status';
      if (action === 'link') printJson(plugin.register());
      else if (action === 'unlink') printJson(plugin.unregister());
      else if (action === 'status') printJson(plugin.registrationStatus());
      else throw new Error(`unknown plugin action: ${action}`);
      return;
    }
    case 'config': {
      // Handy when reporting a problem: where does this install read from?
      printJson({ configPath: configPath(), stateDir: stateDir(), config });
      return;
    }
    default:
      process.stderr.write(`herdr-remote: unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

/** Runs the command line and reports a failure as the exit code. */
function run() {
  main().catch((error) => {
    process.stderr.write(`herdr-remote: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { main, run, parseArgs, describeStatus, USAGE, VERSION };
