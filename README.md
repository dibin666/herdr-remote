# Herdr Remote

*[English](README.md) · [简体中文](README.zh-CN.md)*

[![herdr-remote on npm](https://img.shields.io/npm/v/herdr-remote?label=herdr-remote&color=0b7285)](https://www.npmjs.com/package/herdr-remote)
[![herdr-remote-relay on npm](https://img.shields.io/npm/v/herdr-remote-relay?label=herdr-remote-relay&color=0b7285)](https://www.npmjs.com/package/herdr-remote-relay)
[![node](https://img.shields.io/node/v/herdr-remote)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/herdr-remote)](./LICENSE)

Web terminal client for [Herdr](https://herdr.dev) workspaces. Supports mobile touch controls, low-latency ANSI streaming, and one-time pairing.

```bash
npm install -g herdr-remote
herdr-remote
```

Running `herdr-remote` launches the setup wizard and starts background services.

---

## Packages

| Package | Target | Description |
|---|---|---|
| **`herdr-remote`** | Workstation | Herdr plugin, host connector, and configuration TUI |
| **`herdr-remote-relay`** | Anywhere | Standalone WebSocket relay and WebUI assets |

`herdr-remote` runs a local relay automatically unless configured to use an external one.

## Connection Modes

| Mode | Reachability | External Server |
|---|---|---|
| **This machine only** *(default)* | Local workstation browser | No |
| **Local network / Tailscale** | Devices on LAN or Tailnet | No |
| **Official relay** | Internet | No (`wss://herdr-remote.564616.xyz`) |
| **Self-hosted relay** | Internet | Yes ([Guide](docs/self-hosted-relay.md) · [中文](docs/self-hosted-relay.zh-CN.md)) |

## TUI

Run `herdr-remote` without arguments to open the configuration TUI (Chinese/English, follows `$LANG` by default).

```
 Herdr Remote  Remote browser access to Herdr workspaces

 1 Overview  2 Pair a device  3 Services  4 Relay  5 Keep-alive  6 Herdr  7 Language & about
 ╭──────────────────────────────────────────────────────────────────────╮
 │ Status                                                               │
 │                                                                      │
 │ Access mode         This machine only                                │
 │ Relay               ● local, 127.0.0.1:8787  pid 1239815             │
 │ Host connector      ● running  pid 1239816                           │
 │ Herdr socket        ● /home/you/.config/herdr/herdr.sock             │
 │ Web UI              http://127.0.0.1:8787                            │
 │ Keep-alive          ● systemd — running                              │
 ╰──────────────────────────────────────────────────────────────────────╯
  ↑↓ move  ·  ↵ select  ·  ← → switch tab  ·  m mouse toggle  ·  q quit
```

### Keybindings

- `↑↓`: Navigate
- `↵`: Select or edit
- `←→` or `1`–`7`: Switch tab
- `s`: Save
- `r`: Refresh status
- `m`: Toggle mouse
- `q`: Quit

## Pairing

1. Open the **Pair a device** tab in TUI (or run `herdr-remote pair`).
2. Scan the QR code or enter the 6-character code in the browser.
3. Pairing codes expire in 10 minutes and are single-use.

## Keep-Alive Service

Install background service via the **Keep-alive** tab or CLI:
- **Linux**: systemd user unit (`loginctl enable-linger` for boot persistence)
- **macOS**: LaunchAgent
- **Fallback**: Background supervisor process

```bash
herdr-remote keepalive install | uninstall | restart | status
```

## CLI Reference

```bash
herdr-remote start | stop | restart
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

## Herdr Plugin Registration

Register as a native Herdr plugin:

```bash
herdr-remote plugin link
```

## Configuration

Settings: `~/.config/herdr-remote/config.json`

```json
{
  "ui":        { "language": "auto" },
  "relay":     { "mode": "local", "port": 8787, "lanHost": "", "publicUrl": "", "remoteUrl": "" },
  "herdr":     { "socketPath": null, "args": [] },
  "keepalive": { "manager": "auto" }
}
```

Authentication tokens and secrets are stored in `~/.local/state/herdr-remote/runtime.json` (mode `0600`).

## Security

- Relay brokers WebSocket streams without running shells or accessing local sockets directly.
- Authentication tokens are hashed with SHA-256; terminal content is never written to disk.
- Every paired window shares one terminal with full input; pairing, not a control lease, is the permission boundary.
- Pairing codes are single-use, rate-limited, and expire in 10 minutes.

## Development

```bash
npm install
npm run build      # Build WebUI and TUI bundle
npm test           # Run relay and CLI test suites
npm run test:web   # Run WebUI tests
npm run typecheck  # TypeScript check
```

### Releases

Versions are not edited by hand. Pushing a change under `packages/cli/` or
`packages/relay/` to `master` makes the *npm publish* workflow bump that
package's patch version, publish it, and commit the new version back with a
`herdr-remote-v0.2.4` / `herdr-remote-relay-v0.2.2` tag. Each package moves on
its own; a package nothing touched is left alone.

Run the workflow manually to release something else: `packages` picks which
packages to release (`auto`, `cli`, `relay`, `both`) and `bump` picks the
component (`patch`, `minor`, `major`).

What a push would release can be checked from a clone:

```bash
.github/scripts/plan-release.sh auto
```

The workflow needs the `NPM_TOKEN` repository secret (an npm *automation*
token, which bypasses 2FA) and permission to push to `master`.

## License

MIT
