# Herdr Remote protocol

Protocol version `1` has two WebSocket roles. The host connector is the only
component that can see Herdr credentials or the local socket. Browsers never
receive the socket path.

## Host connection

The host connects to `/ws/host` and sends:

```json
{
  "type": "host_hello",
  "protocol": 1,
  "hostId": "host-example",
  "token": "...",
  "password": "...",
  "hostname": "workstation",
  "platform": "linux",
  "arch": "x64",
  "capabilities": ["host_handoff", "idle_heartbeat"],
  "terminalPalette": {
    "background": "#222226",
    "foreground": "#ffffff",
    "cursor": "#ffffff",
    "ansi": { "black": "#2e3436", "red": "#cc0000", "...": "16 slots" }
  }
}
```

Two different secrets, with two different jobs:

- `password` is the relay's shared password (`RELAY_PASSWORD`), and decides who
  may **join** the relay at all. A relay started without one is public and
  accepts any workstation; `password` is then ignored.
- `token` is generated on the workstation and decides who may act **as this
  workstation**. The relay stores only its SHA-256 hash. The first connection
  for a given `hostId` enrols it; later connections must present the same token
  or are rejected with `host_auth_failed`.

That split is what makes a public relay safe to share: joining is open, but each
workstation remains reachable only by whoever holds its host token.

The relay responds with `host_ready` and an optional `clientCount`. It also
sends `client_count` whenever the number of attached browser windows changes.
The host sends `heartbeat` JSON messages containing load and PTY metadata only
while `clientCount > 0`; when no browser is attached it keeps only the WebSocket
ping/pong liveness connection. The relay sends `session_start`, `session_stop`,
and `resize` messages back to the host.

A host advertising `host_handoff` may temporarily disconnect without dropping
already-authorized browser sockets. The relay sends `host_reconnecting`, keeps
them for the configured grace period, and starts a fresh shared session after
the host authenticates again. `session_restarted` tells browsers to clear the
old terminal buffer before rendering the new PTY. Clients without the capability
fall back to the original close-and-reconnect behavior.

### Terminal colors

A PTY carries color *indices*, not colors: whoever renders the stream decides
what "red" and "the default background" look like. Left alone, a browser would
show the same Herdr session in its own palette, which is why the workstation
reports its terminal's colors.

The host asks its own terminal at start-up with the standard queries — OSC 10
(foreground), OSC 11 (background), OSC 12 (cursor) and OSC 4 for each of the
sixteen ANSI slots — and puts the answers in `terminalPalette`. The capture
happens in whichever start path still has a terminal attached and is passed to
the (usually detached) connector in `HERDR_TERM_PALETTE_JSON`; the last known
palette is also remembered in the state file, so a later start from a service
manager still knows what the workstation looks like.

`terminalPalette` is optional and every field in it is optional: a terminal
that reports its ANSI ramp but not its default background still contributes
what it knows. Started from a focused, interactive terminal the probe reaches
the emulator itself and returns the full set; started where a multiplexer
answers on the emulator's behalf it may return only the sixteen ANSI colors.
A host with no terminal to ask at all sends `null`, and the browser then keeps
its own defaults — no side of this protocol ever invents a color. The relay validates the palette
(plain `#rrggbb` only, and an all-or-nothing set of sixteen ANSI slots) before
forwarding it, because it ends up in a browser's renderer options.

## Browser connection

The browser connects to `/ws/client` and sends `hello` with either a one-time
`pairCode` or a previously issued device `token`:

```json
{
  "type": "hello",
  "protocol": 1,
  "pairCode": "AB12XYZ",
  "clientId": "phone-1",
  "cols": 80,
  "rows": 24,
  "capabilities": ["host_handoff"]
}
```

The relay responds with `paired` when a new device token was issued, followed
by `ready`. `ready` carries the workstation's `terminalPalette` (or `null`),
delivered before the first PTY byte so the terminal is painted in the host's
colors from its first frame instead of repainting mid-session, and `clientCount`,
the number of windows now sharing this terminal.

JSON frames carry control messages. Binary frames carry raw terminal input from
any attached window, or raw ANSI output from the host. The relay adds a small
internal routing header only on the host-side binary hop and removes it before
forwarding bytes to the browser.

### One terminal, many windows

Every window paired to a workstation is a view of the *same* PTY:

- the first window to attach starts the session; the relay allocates one
  `streamId` for the workstation and sends a single `session_start`;
- output from the host is broadcast to every attached window, and the relay
  keeps the last 512 KB of that stream so a window joining later is replayed
  what has already been printed rather than facing a blank screen. This is a
  catch-up, not a screen snapshot: the relay does not emulate a terminal, so a
  window that joins mid-session sees a correct screen only once the program has
  redrawn itself. The geometry change that follows the join is what usually
  prompts that redraw, and a full-screen program that ignores `SIGWINCH` may
  need a repaint (`^L`) before the two windows agree exactly;
- input from any window is written to that one PTY — there is no control lease
  and no read-only role. Pairing is the permission boundary; past it, every
  window may type;
- the shared grid is the *smallest* attached window, as it is in tmux: a column
  a phone cannot show is a column the program must not paint, or every other
  window sees wrapped output. A window joining or leaving re-computes it, and
  the result is announced to the workstation *and* to every window as
  `shared_resize`. A browser renders that grid rather than its own width, and
  keeps reporting its own width in `resize` — which is the number the minimum
  is computed from;
- the PTY is stopped only when the last window has gone, so closing one tab
  never kills the session another tab is still watching.

`claim_control` and `release_control` remain answered — with a grant and a
`control_state` respectively — so clients built against protocol 1 keep working,
but they no longer move anything.

## HTTP endpoints

- `GET /healthz` — unauthenticated tenant-blind liveness (no host/client counts).
- `GET /api/info` — unauthenticated UI capabilities and deployment mode; it
  does not include host, client, or PTY data.
- `GET /api/status` — workstation-scoped dashboard metrics; authenticated with
  a device token (`Authorization: Bearer …`) or host headers. It never returns
  another host's clients, PTYs, devices, or traffic.
- `GET /api/admin/status` — the standalone relay operator dashboard endpoint;
  authenticated with `X-Relay-Admin-Token` when `RELAY_ADMIN_TOKEN` is set.
- `POST /api/pair/start` — creates a pairing code for one workstation.
- `/` and `/admin` — the built frontend.

The relay operator token is intentionally separate from `RELAY_PASSWORD`: the
password is shared with workstations to let them join, while the admin token is
used only to inspect relay-wide clients, hosts, PTYs, and metrics. If no admin
token is configured, an enrolled device or host token may still use
`/api/status`, but `/api/admin/status` remains unavailable.

Pairing is authenticated with the workstation's own identity:

```
X-Herdr-Host-Id:    host-example
X-Herdr-Host-Token: ...
```

The code is minted for that `hostId` and no other, so on a shared relay nobody
can create a pairing code for a workstation they do not own. Attempts are rate
limited per client address (per `X-Forwarded-For` when `RELAY_TRUST_PROXY` is
set).

Pairing and device records are stored as hashes; terminal content is never
persisted by the relay.
