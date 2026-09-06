# herdr-remote-relay

*[English](README.md) · [简体中文](README.zh-CN.md)*

Standalone relay server and WebUI for [Herdr Remote](https://www.npmjs.com/package/herdr-remote).

Brokers WebSocket connections between browsers and workstation host connectors. Runtime dependency is `ws` only; requires no compilers or Herdr binaries.

> **Note**: `herdr-remote` runs a local relay automatically. Install this package only when deploying a dedicated relay server.

## Installation

```bash
npm install -g herdr-remote-relay
herdr-remote-relay --public-url https://herdr.example.com --password <password>
```

Requirements: Node.js 22+, TLS reverse proxy (nginx, Caddy, Cloudflare Tunnel).

## Docker

```bash
docker run -d --name herdr-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v herdr-relay:/data \
  -e RELAY_BIND=0.0.0.0 \
  -e RELAY_PUBLIC_URL=https://herdr.example.com \
  -e RELAY_PASSWORD=your-password \
  -e RELAY_ADMIN_TOKEN=your-admin-token \
  -e RELAY_TRUST_PROXY=1 \
  -e RELAY_AUTH_STATE_FILE=/data/relay-auth.json \
  node:22-alpine npx -y herdr-remote-relay
```

## Options

| Option | Env Var | Default | Description |
|---|---|---|---|
| `--public-url` | `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | Public URL for browsers |
| `--password` | `RELAY_PASSWORD` | *(empty)* | Workstation join password (empty = public) |
| `--admin-token` | `RELAY_ADMIN_TOKEN` | *(empty)* | Operator token for `/admin` |
| `--bind` | `RELAY_BIND` | `127.0.0.1` | Listen address |
| `--port` | `RELAY_PORT` | `8787` | Listen port |
| `--trust-proxy` | `RELAY_TRUST_PROXY` | `0` | Trust `X-Forwarded-For` header (`1` behind proxy) |
| `--state-file` | `RELAY_AUTH_STATE_FILE` | `~/.local/state/herdr-remote-relay/relay-auth.json` | Auth state file path |
| `--allowed-origins` | `RELAY_ALLOWED_ORIGINS` | *(same-origin)* | Allowed CORS origins, comma-separated |
| `--max-clients` | `RELAY_MAX_CLIENTS_PER_HOST` | `16` | Maximum browser clients per host |
| `--config` | `HERDR_RELAY_CONFIG` | *(none)* | JSON configuration file path |

Reverse proxies must pass WebSocket `Upgrade` headers and maintain long idle timeouts. Deployment examples for nginx, systemd, and Docker Compose are in `deploy/`.

## Connecting a Workstation

In `herdr-remote` TUI under **Relay** tab:
- Set mode to **Self-hosted relay**
- Set Relay URL to `wss://herdr.example.com`
- Set Relay Password to matching `RELAY_PASSWORD`

Check connection status:
```bash
curl https://herdr.example.com/healthz
```

## License

MIT
