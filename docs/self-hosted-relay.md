# Running your own relay

*[中文版](./self-hosted-relay.zh-CN.md)*

The relay provides external network access to your workstation. You only need it for the **Self-hosted relay** access mode; "This machine only" and "Local network / Tailscale" modes run a local relay automatically via `herdr-remote`.

Requirements: Node.js 22+, a domain name, and TLS (nginx, Caddy, Traefik, Cloudflare Tunnel).

## Docker

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
```bash
docker pull ghcr.io/dibin666/herdr-remote-relay:latest
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
| `RELAY_MAX_HOSTS` | `1024` | Workstations allowed on this relay |
| `RELAY_MAX_PENDING_HANDSHAKES` | `1024` | Maximum unauthenticated WebSocket handshakes |
| `RELAY_MAX_BUFFERED_BYTES_PER_CLIENT` | `4194304` | Per-browser send queue limit; only slow clients are dropped |
| `RELAY_HOST_RECONNECT_GRACE_MS` | `30000` | Grace period for reconnecting a host while preserving authorized browsers |

## Reverse proxy

Whatever proxy you use, it must forward WebSocket upgrades and maintain reasonable idle
timeouts — a terminal is idle between keystrokes. The relay disables WebSocket compression
and enables TCP NoDelay for terminal frames. When no browser is attached, the workstation pauses
business heartbeats while maintaining low-frequency transport keepalive (minimal idle heartbeat
and WebSocket ping/pong probes) to keep the proxy path open and relay liveness fresh. Example configs
for nginx and Cloudflare Tunnel are in `deploy/` in the package.

## Connect your workstation

Run `herdr-remote` on the workstation, open the **Relay** tab and set:

- **Access mode** → Self-hosted relay
- **Relay URL** → `wss://herdr.example.com`
- **Relay password** → the same `RELAY_PASSWORD` (leave empty for a public relay)

Save with `s`, restart from the **Services** tab, then check:

```bash
curl https://herdr.example.com/healthz    # returns liveness only
curl -H "X-Herdr-Host-Id: <host-id>" -H "X-Herdr-Host-Token: <host-token>" \
  https://herdr.example.com/api/status    # scoped host status
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

- One browser can save multiple workstation pairings. The local switcher never enumerates other hosts on the relay.
- `/api/status` is scoped to the workstation bound to the device/host credentials; only `RELAY_ADMIN_TOKEN` can view relay-wide state.
- If the WebUI is hosted on a different origin, add that exact origin to `RELAY_ALLOWED_ORIGINS`; the relay never reflects arbitrary origins.
- `/healthz` is a tenant-blind liveness endpoint and does not disclose host or client counts.
- Only the reverse proxy needs a public port; keep the relay on loopback.
- The relay stores SHA-256 hashes of tokens, never the tokens. Terminal content
  is never written to disk.
- Pairing codes last 10 minutes and work once.
- Losing the state file just means re-pairing your devices.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/api/status` has no host | Workstation not connected — check `herdr-remote status` |
| `relay_password_required` | Password differs between the two sides |
| Page loads, terminal never opens | Proxy is not forwarding `Upgrade` headers |
| Drops after ~60s idle | Proxy read timeout too short |
