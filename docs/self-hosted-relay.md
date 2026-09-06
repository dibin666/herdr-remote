# Running your own relay

*[中文版](./self-hosted-relay.zh-CN.md)*

The relay lets you reach your workstation from outside your own network. You
only need it for the **Self-hosted relay** access mode — for "This machine only"
and "Local network / Tailscale", `herdr-remote` starts a relay locally and there
is nothing to deploy.

`herdr-remote-relay` is a separate npm package. Its only dependency is `ws`, so
the server needs no compiler, no Herdr and no plugin.

For phone access on the same LAN or tailnet, you do not need a self-hosted relay:
choose **Local network / Tailscale** in `herdr-remote`. Its local relay listens on
`0.0.0.0`; the **Browser access address** in the TUI must be the actual LAN or
Tailscale IP. `0.0.0.0` is a listen wildcard, not an address a browser can open.

Requirements: Node.js 22+, a domain name, and TLS (put any reverse proxy you
like in front — nginx, Caddy, Traefik, Cloudflare Tunnel).

## Docker

Prebuilt images are published to the GitHub Container Registry for `linux/amd64`
and `linux/arm64`:

```
ghcr.io/dibin666/herdr-remote-relay:latest
```

The package is private, so authenticate once with a GitHub token that has the
`read:packages` scope:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u dibin666 --password-stdin
```

```bash
docker run -d --name herdr-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v herdr-relay:/data \
  -e RELAY_PUBLIC_URL=https://herdr.example.com \
  -e RELAY_PASSWORD=your-password \
  -e RELAY_ADMIN_TOKEN=your-long-random-admin-token \
  -e RELAY_TRUST_PROXY=1 \
  ghcr.io/dibin666/herdr-remote-relay:latest
```

`RELAY_BIND=0.0.0.0` and `RELAY_AUTH_STATE_FILE=/data/relay-auth.json` are
already the image defaults, so only the settings above need to be passed. The
image runs as a non-root user (uid 10001) and ships no package manager or
shell tooling beyond BusyBox — it is Alpine plus the Node binary, the relay
sources and `ws`.

Pin a version rather than `latest` for reproducible deployments:

```bash
docker pull ghcr.io/dibin666/herdr-remote-relay:0.1.0
```

## Docker Compose

```yaml
services:
  relay:
    image: ghcr.io/dibin666/herdr-remote-relay:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      RELAY_PUBLIC_URL: https://herdr.example.com
      RELAY_PASSWORD: your-password
      RELAY_ADMIN_TOKEN: your-long-random-admin-token
      RELAY_TRUST_PROXY: "1"
    volumes:
      - relay-state:/data

volumes:
  relay-state:
```

```bash
docker compose up -d
```

### Building the image yourself

The build context is the repository root, because the browser bundle is built
from the `packages/relay/web` workspace:

```bash
docker build -f packages/relay/Dockerfile -t herdr-remote-relay .
```

## npm

```bash
npm install -g herdr-remote-relay
herdr-remote-relay --public-url https://herdr.example.com --password your-password \
  --admin-token your-long-random-admin-token --trust-proxy
```

A systemd unit is included: see `deploy/systemd/` in the package.

## Options

| Variable | Default | |
|---|---|---|
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | URL browsers open |
| `RELAY_DEPLOYMENT_MODE` | `remote` | Marks this as the operator-facing relay (`local` is reserved for the workstation-managed relay) |
| `RELAY_PASSWORD` | *(none)* | Password a workstation must present. **Empty = public relay** |
| `RELAY_ADMIN_TOKEN` | *(none)* | Operator token for the relay dashboard at `/admin` |
| `RELAY_BIND` | `127.0.0.1` | Listen address (`0.0.0.0` in Docker) |
| `RELAY_PORT` | `8787` | Listen port |
| `RELAY_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `RELAY_AUTH_STATE_FILE` | `~/.local/state/herdr-remote-relay/relay-auth.json` | Device records |
| `RELAY_ALLOWED_ORIGINS` | *(same-origin)* | Extra browser origins, comma separated |
| `RELAY_MAX_CLIENTS_PER_HOST` | `16` | Browsers per workstation |

## Reverse proxy

Whatever proxy you use, it must forward WebSocket upgrades and not time out idle
connections — a terminal is idle between keystrokes. Example configs for nginx
and Cloudflare Tunnel are in `deploy/` in the package.

## Connect your workstation

Run `herdr-remote` on the workstation, open the **Relay** tab and set:

- **Access mode** → Self-hosted relay
- **Relay URL** → `wss://herdr.example.com`
- **Relay password** → the same `RELAY_PASSWORD` (leave empty for a public relay)

Save with `s`, restart from the **Services** tab, then check:

```bash
curl https://herdr.example.com/healthz    # hosts should be 1
```

Pair a phone from the **Pair a device** tab.

## Public relays

Leaving `RELAY_PASSWORD` empty makes the relay public: anyone may connect a
workstation to it. That is safe to share, because each workstation is reachable
only through its own host token — generated on that machine, never handed out by
the relay. Nobody else can pair a device to your terminal.

What a public relay does give away is bandwidth and the fact that your
workstation is online. Set a password if that matters.

## Notes

- Only the reverse proxy needs a public port; keep the relay on loopback.
- The relay stores SHA-256 hashes of tokens, never the tokens. Terminal content
  is never written to disk.
- Pairing codes last 10 minutes and work once.
- Losing the state file just means re-pairing your devices.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `hosts: 0` | Workstation not connected — check `herdr-remote status` |
| `relay_password_required` | Password differs between the two sides |
| Page loads, terminal never opens | Proxy is not forwarding `Upgrade` headers |
| Drops after ~60s idle | Proxy read timeout too short |
