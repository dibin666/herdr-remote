# herdr-remote-relay

Standalone relay server for [Herdr Remote](https://www.npmjs.com/package/herdr-remote):
it serves the mobile web terminal and brokers browser ↔ workstation sessions.

Its only runtime dependency is `ws`, so the machine running it needs no
compiler, no Herdr and no plugin. It never runs a shell and never touches your
Herdr socket — only the host connector on your own workstation does that.

**You usually do not need to install this yourself.** `herdr-remote` starts a
relay locally unless you point it at one you host. Install this package only
when you want to reach your workstation from outside your own network.

```bash
npm install -g herdr-remote-relay
herdr-remote-relay --public-url https://herdr.example.com \
  --password your-password --admin-token your-long-random-admin-token \
  --trust-proxy
```

Requirements: Node.js 22+, a domain name, and TLS. Terminate TLS in a reverse
proxy in front of the relay — nginx, Caddy, Traefik and Cloudflare Tunnel all
work. Example configs for nginx, Cloudflare Tunnel, systemd and Docker Compose
ship in `deploy/` inside this package.

## Docker

```bash
docker run -d --name herdr-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v herdr-relay:/data \
  -e RELAY_BIND=0.0.0.0 \
  -e RELAY_PUBLIC_URL=https://herdr.example.com \
  -e RELAY_PASSWORD=your-password \
  -e RELAY_ADMIN_TOKEN=your-long-random-admin-token \
  -e RELAY_TRUST_PROXY=1 \
  -e RELAY_AUTH_STATE_FILE=/data/relay-auth.json \
  node:22-alpine npx -y herdr-remote-relay
```

## Options

Every setting has a flag, an environment variable and a JSON config file key
(`--config`, or `HERDR_RELAY_CONFIG`). Precedence runs defaults → file →
environment → flags.

| Variable | Default | |
|---|---|---|
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:8787` | URL browsers open |
| `RELAY_PASSWORD` | *(none)* | Password a workstation must present. **Empty = public relay** |
| `RELAY_ADMIN_TOKEN` | *(none)* | Operator token for the relay dashboard at `/admin` |
| `RELAY_BIND` | `127.0.0.1` | Listen address (`0.0.0.0` in Docker) |
| `RELAY_PORT` | `8787` | Listen port |
| `RELAY_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `RELAY_AUTH_STATE_FILE` | `~/.local/state/herdr-remote-relay/relay-auth.json` | Device records |
| `RELAY_ALLOWED_ORIGINS` | *(same-origin)* | Extra browser origins, comma separated |
| `RELAY_MAX_CLIENTS_PER_HOST` | `16` | Browsers per workstation |
| `RELAY_DEPLOYMENT_MODE` | `remote` | `local` is reserved for the workstation-managed relay |

Whatever proxy you put in front must forward WebSocket upgrades and must not
time out idle connections — a terminal is idle between keystrokes.

## Public relays

Leaving `RELAY_PASSWORD` empty makes the relay public: anyone may connect a
workstation to it. That is safe to share, because each workstation is reachable
only through its own host token — generated on that machine, never handed out
by the relay. Nobody else can pair a device to your terminal.

What a public relay does give away is bandwidth and the fact that your
workstation is online. Set a password if that matters.

## Connect a workstation

On the workstation, run `herdr-remote`, open the **Relay** tab and set the
access mode to **Self-hosted relay**, the relay URL to
`wss://herdr.example.com`, and the relay password to the same `RELAY_PASSWORD`.
Then check:

```bash
curl https://herdr.example.com/healthz    # hosts should be 1
```

| Symptom | Cause |
|---|---|
| `hosts: 0` | Workstation not connected — check `herdr-remote status` |
| `relay_password_required` | Password differs between the two sides |
| Page loads, terminal never opens | Proxy is not forwarding `Upgrade` headers |
| Drops after ~60s idle | Proxy read timeout too short |

## Security

- Tokens are stored as SHA-256 hashes, never in clear text. Terminal content is
  never written to disk.
- Pairing codes are single-use, expire in ten minutes, and are rate limited.
- The `/admin` operator credential is separate from the workstation join
  password and from paired device tokens.
- Losing the state file just means re-pairing your devices.

## License

MIT
