# herdr-remote

*[English](README.md) · [简体中文](README.zh-CN.md)*

Web terminal client for [Herdr](https://herdr.dev) workspaces. Mobile-friendly UI, low-latency ANSI streaming, and bilingual configuration TUI.

## Installation & Usage

```bash
npm install -g herdr-remote
herdr-remote
```

Running `herdr-remote` without arguments launches the setup wizard and configuration TUI.

## Connection Modes

- **This machine only** *(default)*: Local workstation browser (127.0.0.1).
- **Local network / Tailscale**: Accessible over LAN or Tailnet (0.0.0.0).
- **Official relay**: Public relay at `wss://herdr-remote.564616.xyz`.
- **Self-hosted relay**: External access via standalone [`herdr-remote-relay`](https://www.npmjs.com/package/herdr-remote-relay).

## CLI Commands

```bash
herdr-remote start | stop | restart
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote keepalive install | uninstall | restart | status
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

## Herdr Plugin

Register as a native Herdr plugin:

```bash
herdr-remote plugin link
```

## Configuration

- Settings: `~/.config/herdr-remote/config.json`
- Runtime state: `~/.local/state/herdr-remote/runtime.json` (mode `0600`)

## Locating Herdr

The `herdr` binary is looked up in `HERDR_BIN_PATH`, then `PATH`, then the usual
install directories (`~/.local/bin`, `~/.cargo/bin`, `~/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, …). `herdr-remote keepalive install` writes the binary it found
and the current `PATH` into the systemd unit or launchd agent, because a service
manager does not inherit your shell's environment.

`herdr-remote status --json` reports `host.herdrCommand` and `host.herdrCommandFound`.
If it was not found, set `HERDR_BIN_PATH` to the full path and reinstall the
keep-alive service.

## License

MIT
