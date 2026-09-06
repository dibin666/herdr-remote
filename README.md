# Herdr Remote

Use your [Herdr](https://herdr.dev) terminal workspaces from a phone or any
browser. A mobile-first web terminal with low-latency ANSI streaming, one-time
pairing codes, and a bilingual configuration TUI.

```bash
npm install -g herdr-remote
herdr-remote
```

That opens the setup wizard: pick a language, pick how you want to reach the
machine, and it starts the services for you.

---

## Two packages

| Package | Runs on | Contains |
|---|---|---|
| **`herdr-remote`** | your workstation | Herdr plugin, host connector, configuration TUI |
| **`herdr-remote-relay`** | wherever you want | the relay and the web terminal |

The relay is completely separate: its only dependency is `ws`, so a server
running one needs no compiler, no Herdr and no plugin. You do not have to
install it yourself — `herdr-remote` starts one locally unless you point it at
your own.

An operator-run relay can expose its relay-wide dashboard at `/admin` by
setting `RELAY_ADMIN_TOKEN`. That credential is separate from the workstation
join password and from paired device tokens; relay-wide metrics are served by
`/api/admin/status`, and the terminal WebUI does not use a device token as a
relay operator credential.

## Three ways to connect

| Mode | Who can reach it | Needs a server? |
|---|---|---|
| **This machine only** *(default)* | a browser on the workstation | no |
| **Local network / Tailscale** | phones on your LAN or tailnet | no |
| **Self-hosted relay** | anywhere, over the internet | yes — [guide](docs/self-hosted-relay.md) · [中文](docs/self-hosted-relay.zh-CN.md) |

Without a relay configured, the web UI is served from a local address only.
This already covers being away from home if you run Tailscale or WireGuard.
Only a self-hosted relay opens access from outside your network.

## The TUI

`herdr-remote` with no arguments opens the interface. It is bilingual —
Chinese or English, following `$LANG` unless you choose otherwise — and works
with the keyboard or the mouse.

```
 Herdr Remote  Remote browser access to your Herdr workspaces

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
 │                                                                      │
 │ Workstations        1                                                │
 │ Browsers            0                                                │
 │ Relay uptime        4m 2s                                            │
 ╰──────────────────────────────────────────────────────────────────────╯
  ↑↓ move  ·  ↵ select  ·  ← → switch tab  ·  m mouse off  ·  q quit
```

| Tab | |
|---|---|
| **Overview** | live service, socket and keep-alive status |
| **Pair a device** | one-time code with a QR you can scan |
| **Services** | start, stop, restart, recent logs |
| **Relay** | access mode, port, listen address, browser access address, relay URL and password |
| **Keep-alive** | install or remove the background service |
| **Herdr** | socket path, arguments, plugin registration |
| **Language & about** | Chinese / English / follow the system |

Keys: `↑↓` move · `↵` select or edit · `←→` or `1`–`7` switch tab · `s` save ·
`r` refresh · `m` toggle mouse · `q` quit.

Mouse tracking turns itself on where the terminal supports it. It takes over
text selection while active, so press `m` when you want to copy something.

## Pairing

Open **Pair a device** and press Enter. Scan the QR code, or enter the six
characters on the page. The browser gets a long-lived token; the code is burned
on first use and expires after ten minutes.

## Keeping it running

The **Keep-alive** tab installs a service that starts the relay and host
connector at login and restarts them if they die — a systemd user unit on
Linux, a LaunchAgent on macOS, and a supervised background process where
neither is available.

On Linux, "Enable start at boot" runs `loginctl enable-linger` so it also comes
up before you log in.

## Command line

Everything the TUI does is scriptable:

```bash
herdr-remote start | stop | restart
herdr-remote status [--json]
herdr-remote pair [--json]
herdr-remote url
herdr-remote keepalive install | uninstall | restart | status
herdr-remote plugin link | unlink | status
herdr-remote --lang zh|en
```

## Herdr plugin

The package is also a Herdr plugin. Register it from the **Herdr** tab, or:

```bash
herdr-remote plugin link
```

Nothing is compiled at registration time — the npm package ships prebuilt.

> Upgrading from a source checkout? Unlink the old one first:
> `herdr plugin unlink herdr.remote.web`. Your settings are migrated
> automatically on first run.

## Configuration

`~/.config/herdr-remote/config.json`, edited through the TUI:

```json
{
  "ui":        { "language": "auto" },
  "relay":     { "mode": "local", "port": 8787, "lanHost": "", "publicUrl": "", "remoteUrl": "" },
  "herdr":     { "socketPath": null, "args": [] },
  "keepalive": { "manager": "auto" }
}
```

Secrets are never stored here. The workstation's host token and the relay
password live in `~/.local/state/herdr-remote/runtime.json`, mode 0600.

## Security

- The relay never runs a shell and never sees your Herdr socket; only the host
  connector on your machine does.
- Tokens are stored as SHA-256 hashes. Terminal content is never written to disk.
- Pairing codes are single-use, expire in ten minutes, and are rate limited.
- Secrets never appear in URLs or shell history; the web UI strips them from the
  address bar after pairing.
- One writable controller at a time, with explicit takeover; other devices watch
  read-only.

## Development

```bash
npm install
npm run build          # web UI, then the TUI bundle
npm test               # relay and CLI suites
npm run typecheck
```

```
packages/relay/   herdr-remote-relay — relay server + web UI (ws only)
packages/cli/     herdr-remote — TUI, host connector, plugin manifest
docs/             protocol and self-hosting guides
```

## License

MIT
