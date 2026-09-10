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
them for the configured grace period, and — once the host authenticates again —
starts a fresh session for each window it held, one `session_start` per window.
`session_restarted` tells each browser to clear the old terminal buffer before
rendering its new PTY. Clients without the capability fall back to the original
close-and-reconnect behavior.

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

There are two framing formats on the host-relay hop:

1. **Format v1 (legacy)**:
   - Layout: `4-byte uint32BE headerLength` + `UTF-8 JSON header` + `raw payload`.
   - The JSON header contains routing fields: `{"type":"output"|"input","streamId":"..."}`.
   - Because `headerLength` is bounded by `MAX_HEADER_BYTES = 8192`, its first byte is always `0x00`.

2. **Format v2 (compact binary framing)**:
   - Layout: `1-byte magic (0xFF)` + `1-byte type` + `2-byte uint16BE streamIndex` + `raw payload` (4-byte fixed header).
   - `type` is numeric: `0 = output`, `1 = input`.
   - `streamIndex` is an unsigned 16-bit integer scoped per host.
   - Unambiguous discrimination: the first byte of a v2 frame is always `0xFF`, whereas a v1 frame's first byte is always `0x00`.

**Capability negotiation & compatibility**:
- The host connector declares the `"binary_frame_v2"` capability in its `host_hello` message.
- If declared, the relay allocates a per-host unique `streamIndex` (0–65535) and sends it in the `session_start` control message. Both sides then exclusively communicate using v2 binary frames for that host.
- If not declared (or when communicating with older hosts), the relay continues to speak format v1, maintaining full backwards compatibility.

**Motivation**:
Because the relay already enables WebSocket `permessage-deflate`, repeated JSON headers in v1 frames were already compressed down to negligible bandwidth. The real benefit of v2 is saving CPU: eliminating per-frame `JSON.stringify` / `JSON.parse` and string allocations under intense terminal throughput.

### One terminal per window

Every window paired to a workstation gets a PTY of its own:

- each window that attaches starts its own session; the relay allocates a
  `streamId` per window and sends one `session_start` carrying that window's own
  geometry, floored at 20×6 so a program always has something to draw in;
- output is *routed*, not broadcast. The relay keeps a `streamId` → window map
  and hands each host frame to the single window that owns it. Nothing is
  replayed to a window joining later, because a late window is not joining
  anything: it starts a fresh Herdr client, which paints its own first frame;
- input from a window is stamped with that window's `streamId`. There is no
  control lease and no read-only role — pairing is the permission boundary, and
  past it every window types into its own terminal;
- geometry is per window. A `resize` is forwarded straight through to that
  window's stream, so a phone reporting 40 columns no longer shrinks the laptop
  looking at the same workstation;
- closing a window stops only its own PTY. The other windows are untouched.

This is what Herdr 0.9.0 made possible. Before it, a Herdr server broadcast one
view — one focused workspace, tab and pane — to every attached client, so two
PTYs would only have produced two identical mirrors at two different sizes;
collapsing them into one shared stream was the honest thing to do. Herdr 0.9.0
moved the terminal UI into each client, and a client now carries its own focused
tab and its own tab geometry. One PTY per window is what turns that into two
windows that can genuinely look at different work.

One caveat inherited from Herdr: when two windows sit on the *same* tab, that
tab is sized by whichever client interacted with it last. Independent sizing
follows from looking at different tabs, and no relay-side behavior can change
that.

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

## Pasted image files

Browsers can transfer clipboard images to the workstation. Because PTY streams only consume text,
the image payload is saved to host state storage and the resulting local file path is pasted
into the active terminal.

### Client to relay (`paste_file`)

Sent as a JSON message over `/ws/client`:

```json
{
  "type": "paste_file",
  "mime": "image/png",
  "dataBase64": "..."
}
```

- Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Size limit: 3 MB decoded raw binary (base64 payload must not exceed ~4 MB).
- Error codes returned on client error:
  - `paste_file_unsupported`: MIME type is not in the whitelist or payload is malformed.
  - `paste_file_too_large`: Decoded payload exceeds 3 MB. The connection remains open.

### Relay to host

The relay validates the MIME whitelist and 3 MB payload cap, stamps the message with the
originating client's `streamId`, and forwards it over `/ws/host`:

```json
{
  "type": "paste_file",
  "clientId": "stream-id-1",
  "streamId": "stream-id-1",
  "mime": "image/png",
  "dataBase64": "..."
}
```

### Host processing & security

The host connector performs strict independent security checks before writing:
1. **Pinned directory**: Files are written strictly to `<stateDir>/pasted` (directory mode `0o700`).
2. **Unpredictable filename**: Generated via `crypto.randomUUID()`; client-supplied names are never used.
3. **Whitelisted extension**: Derived directly from the validated MIME (`.png`, `.jpg`, `.webp`, `.gif`).
4. **Host size re-validation**: The host independently enforces the 3 MB ceiling.
5. **Magic bytes sniffing**: Raw binary headers are validated against declared MIME:
   - PNG: `89 50 4E 47`
   - JPEG: `FF D8 FF`
   - GIF: `47 49 46 38`
   - WebP: `RIFF` (bytes 0..3) and `WEBP` (bytes 8..11)
   Mismatches are rejected to prevent file-type spoofing.
6. **File mode**: Created with mode `0o600`.
7. **Retention and pruning**: Caps at 20 files and 50 MB (oldest deleted first). Residual files older than 24 hours are deleted upon startup.

If writing or validation fails, the host returns an error over the existing channel:
```json
{
  "type": "error",
  "clientId": "stream-id-1",
  "code": "paste_file_write_failed",
  "message": "..."
}
```

### Host to relay and client (`paste_file_ready`)

Upon successfully saving the file, the host returns:
```json
{
  "type": "paste_file_ready",
  "clientId": "stream-id-1",
  "path": "/home/user/.local/state/herdr-remote/pasted/uuid.png"
}
```

The relay routes `paste_file_ready` exclusively to the initiating client window.
