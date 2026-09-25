// The browser side of the relay: a window's WebSocket, from its hello and
// pairing to every message and keystroke it sends after.

import type { IncomingMessage } from 'node:http';
import type { RawData } from 'ws';
import {
  CAPABILITY,
  type ClientHelloMessage,
  type ClientJsonMessage,
  FRAME_TYPE_INPUT,
  PASTE_MAX_BYTES,
  PROTOCOL_VERSION,
  hasImageSignature,
  isPasteImageMime,
  packStreamFrame,
  packStreamFrameV2,
} from '../protocol/index.js';
import { requestFontChunk, requestFontSubset } from './font-proxy.js';
import { allowClientHandshake, allowPairAttempt, clientAddress } from './requests.js';
import {
  MIN_SESSION_COLS,
  MIN_SESSION_ROWS,
  beginHostReconnect,
  broadcastControlState,
  detachClient,
  startSession,
} from './sessions.js';
import {
  clampDimension,
  closeSocket,
  isOpen,
  jsonSend,
  parseJson,
  randomId,
  rejectHandshake,
} from './sockets.js';
import { enqueueDelayedSend, notifyHostClientCount } from './transport.js';
import type { RelayClient, RelayContext, RelaySocket } from './types.js';

/** A window's socket between its connection and its hello, and the record after. */
interface PendingClient {
  ws: RelaySocket;
  req: IncomingMessage;
  authenticated: boolean;
  client?: RelayClient;
}

/** A window asks to start its workstation's Herdr at most this often. */
const HERDR_START_REPEAT_MS = 3_000;

/** A window asks its workstation to re-read the terminal font at most this often. */
const FONT_REFRESH_REPEAT_MS = 2_000;

export function verifyImageMagicBytes(mime: string, dataBase64: unknown): boolean {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return false;
  let headerBuf: Buffer;
  try {
    headerBuf = Buffer.from(dataBase64.slice(0, 32), 'base64');
  } catch {
    return false;
  }
  if (headerBuf.length === 0) return false;
  return hasImageSignature(mime, headerBuf);
}

export function handleClientConnection(
  relay: RelayContext,
  ws: RelaySocket,
  req: IncomingMessage,
): void {
  const pending: PendingClient = { ws, req, authenticated: false };
  const deadline = setTimeout(() => {
    if (!pending.authenticated) closeSocket(ws, 1008, 'client hello timeout');
  }, 10000);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (pending.client) {
      pending.client.lastSeenAt = Date.now();
      pending.client.lastPingAt = new Date().toISOString();
    }
  });
  ws.on('ping', () => {
    ws.isAlive = true;
    if (pending.client) {
      pending.client.lastSeenAt = Date.now();
      pending.client.lastPingAt = new Date().toISOString();
    }
  });
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (!pending.authenticated) {
      if (isBinary) return rejectHandshake(ws, 'client hello must be JSON');
      const message = parseJson<ClientHelloMessage>(raw.toString());
      if (message?.type !== 'hello' || message.protocol !== PROTOCOL_VERSION)
        return rejectHandshake(ws, 'invalid client hello');
      if (!allowClientHandshake(relay, req))
        return rejectHandshake(ws, 'too many connection attempts', 'rate_limited');
      let device: { deviceId: string; hostId: string } | null = null;
      let paired: ReturnType<typeof relay.auth.completePairing> = null;
      if (message.pairCode) {
        if (!allowPairAttempt(relay, req))
          return rejectHandshake(ws, 'too many pairing attempts', 'rate_limited');
        paired = relay.auth.completePairing(message.pairCode);
      }
      if (paired) device = paired;
      else if (message.token) device = relay.auth.authenticateDevice(message.token);
      if (!device)
        return rejectHandshake(ws, 'valid device token or pairing code required', 'auth_required');
      const host = relay.hosts.get(device.hostId);
      if (!host || host.reconnecting || !isOpen(host.ws))
        return rejectHandshake(
          ws,
          'paired Herdr host is offline',
          host?.reconnecting ? 'host_reconnecting' : 'host_offline',
        );

      // Two tabs of one browser are separate windows with their own PTY sessions,
      // not rivals. Nothing is retired here: each connection gets its own stream
      // without evicting existing clients.
      if (host.clients.size >= relay.config.relay.maxClientsPerHost)
        return rejectHandshake(ws, 'host client limit reached', 'too_many_clients');
      clearTimeout(deadline);
      relay.finishHandshake(ws);
      const clientId = randomId('client');
      const client: RelayClient = {
        id: clientId,
        ws,
        hostId: host.id,
        deviceId: device.deviceId,
        // Stable per browser profile; used to recognise a reconnect from the
        // same browser rather than a genuinely separate viewer.
        browserClientId:
          typeof message.clientId === 'string' ? message.clientId.slice(0, 128) : null,
        handoffCapable:
          Array.isArray(message.capabilities) &&
          message.capabilities.includes(CAPABILITY.hostHandoff),
        session: null,
        // Every paired window gets its own interactive PTY session. Pairing
        // is the permission boundary; once a device is through it, every
        // window can type into its own terminal.
        role: 'controller',
        controllerId: null,
        connectedAt: new Date().toISOString(),
        connectedAtMs: Date.now(),
        lastSeenAt: Date.now(),
        lastPingAt: null,
        bytesReceived: 0,
        bytesSent: 0,
        ip: clientAddress(relay, req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
        cols: clampDimension(message.cols, 80),
        rows: clampDimension(message.rows, 24),
      };
      client.controllerId = null;
      // Persist how this device identifies itself so the operator dashboard
      // can name it in the revoke list instead of showing a bare device id.
      relay.auth.noteDeviceSeen(device.deviceId, { userAgent: client.userAgent, ip: client.ip });
      pending.authenticated = true;
      pending.client = client;
      relay.clients.set(client.id, client);
      host.clients.add(client.id);
      notifyHostClientCount(host);
      ws.isAlive = true;
      if (paired)
        jsonSend(ws, {
          type: 'paired',
          token: paired.token,
          deviceId: paired.deviceId,
          hostId: paired.hostId,
          expiresAt: paired.expiresAtIso,
        });
      // Expose the relay-assigned connection id so clients can distinguish
      // their own controller lease from another device's lease. The browser
      // supplied clientId identifies a device, not this live WebSocket.
      jsonSend(ws, {
        type: 'ready',
        role: client.role,
        // There is no controller to name: every window has full input. The
        // field stays in the message for clients built against protocol 1,
        // which read it to decide whether somebody else held the lease — and
        // `null` is exactly the answer that means "nobody does".
        controllerId: null,
        hostId: host.id,
        hostname: host.hostname,
        clientId: client.id,
        // Delivered with `ready`, before the first PTY byte, so the terminal
        // is painted in the host's colors from its very first frame.
        terminalPalette: host.terminalPalette || null,
        terminalFont: host.terminalFont || null,
        clientCount: host.clients.size,
      });
      if (host.agentStatus) jsonSend(ws, host.agentStatus);
      if (host.updateStatus) jsonSend(ws, host.updateStatus);
      startSession(relay, host, client);
      broadcastControlState(relay, host);
      return;
    }
    if (pending.client) handleClientMessage(relay, pending.client, raw, isBinary);
  });
  ws.on('close', () => {
    clearTimeout(deadline);
    if (pending.client) detachClient(relay, pending.client, { notify: true });
  });
  ws.on('error', () => {});
}

export function handleClientMessage(
  relay: RelayContext,
  client: RelayClient,
  raw: RawData,
  isBinary: boolean,
): void {
  client.lastSeenAt = Date.now();
  const host = relay.hosts.get(client.hostId);
  if (!host) {
    detachClient(relay, client, { notify: true, reason: 'host_offline' });
    return;
  }
  if (isBinary) {
    // The server keeps ws's default binaryType, so a binary frame is one Buffer.
    const bytes = raw as Buffer;
    if (bytes.length > relay.config.relay.maxPayloadBytes) return;
    if (!client.session) return;
    // Each window owns its own PTY session, so input is stamped with the
    // client's dedicated stream id or streamIndex.
    const frame =
      host.binaryFrameV2 && typeof client.session.streamIndex === 'number'
        ? packStreamFrameV2(FRAME_TYPE_INPUT, client.session.streamIndex, bytes)
        : packStreamFrame('input', client.session.streamId, bytes);
    if (isOpen(host.ws)) {
      const doSend = () => {
        if (!isOpen(host.ws)) return;
        try {
          host.ws.send(frame);
          client.bytesReceived += bytes.length;
          relay.metrics.recordIn(bytes.length, host.id);
        } catch {
          beginHostReconnect(relay, host, 'host_send_failed');
        }
      };
      if (relay.devLatencyMs > 0) enqueueDelayedSend(relay, host.ws, doSend);
      else doSend();
    }
    return;
  }
  // Untrusted: each branch reads only the fields its message type defines.
  const message = parseJson<ClientJsonMessage>(raw.toString());
  if (!message) {
    jsonSend(client.ws, { type: 'error', code: 'invalid_json', message: 'message must be JSON' });
    return;
  }
  if (message.type === 'ping') {
    client.lastPingAt = new Date().toISOString();
    jsonSend(client.ws, { type: 'pong' });
  } else if (message.type === 'resize') {
    // Each client owns its own PTY session, so resizing directly forwards
    // the new geometry for this client's stream to the host.
    client.cols = clampDimension(message.cols, client.cols);
    client.rows = clampDimension(message.rows, client.rows);
    if (client.session) {
      client.session.cols = client.cols;
      client.session.rows = client.rows;
      if (isOpen(host.ws)) {
        jsonSend(host.ws, {
          type: 'resize',
          clientId: client.session.streamId,
          streamId: client.session.streamId,
          cols: Math.max(MIN_SESSION_COLS, client.cols),
          rows: Math.max(MIN_SESSION_ROWS, client.rows),
        });
      }
    }
  } else if (message.type === 'herdr_start') {
    // The window's own workstation, and nobody else's: `host` was fixed by
    // the device token at handshake, and nothing in this message can name
    // another one. The host starts Herdr as its own user, at its own socket.
    // Repeats are dropped — one click is enough, and the host shares a
    // start between windows anyway.
    if (!client.session) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'no_session',
        message: 'terminal session is not ready',
      });
      return;
    }
    const now = Date.now();
    if (client.herdrStartAt && now - client.herdrStartAt < HERDR_START_REPEAT_MS) return;
    client.herdrStartAt = now;
    if (isOpen(host.ws)) {
      jsonSend(host.ws, {
        type: 'herdr_start',
        clientId: client.session.streamId,
        streamId: client.session.streamId,
      });
    }
  } else if (message.type === 'host_font_chunk_request') {
    requestFontChunk(host, client, message);
  } else if (message.type === 'host_font_subset_request') {
    requestFontSubset(host, client, message);
  } else if (message.type === 'host_font_refresh') {
    // Same routing as herdr_start: only the workstation this window is
    // bound to, and only what it offered. Repeats inside the window are
    // dropped; the answer is broadcast to every window anyway.
    if (!client.session || !isOpen(host.ws)) return;
    const now = Date.now();
    if (client.fontRefreshAt && now - client.fontRefreshAt < FONT_REFRESH_REPEAT_MS) return;
    client.fontRefreshAt = now;
    jsonSend(host.ws, {
      type: 'host_font_refresh',
      clientId: client.session.streamId,
      streamId: client.session.streamId,
    });
  } else if (message.type === 'claim_control') {
    // Control is no longer a lease. Answering the old request keeps clients
    // built against the previous protocol working.
    client.role = 'controller';
    jsonSend(client.ws, { type: 'control_granted' });
  } else if (message.type === 'release_control') {
    // Nothing to release: the window keeps its input either way, and saying
    // so beats a silence an older client would wait on.
    jsonSend(client.ws, { type: 'control_state', role: 'controller', controllerId: null });
  } else if (message.type === 'paste_file') {
    if (client.role === 'viewer') {
      jsonSend(client.ws, {
        type: 'error',
        code: 'viewer_mode',
        message: 'Viewer mode cannot paste to terminal',
      });
      return;
    }
    if (!isPasteImageMime(message.mime)) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'paste_file_unsupported',
        message: 'Unsupported paste image format',
      });
      return;
    }
    if (typeof message.dataBase64 !== 'string') {
      jsonSend(client.ws, {
        type: 'error',
        code: 'paste_file_unsupported',
        message: 'Invalid paste image payload',
      });
      return;
    }
    const rawLength = Buffer.byteLength(message.dataBase64, 'base64');
    if (rawLength === 0) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'paste_file_empty',
        message: 'Pasted image payload is empty',
      });
      return;
    }
    if (rawLength > PASTE_MAX_BYTES) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'paste_file_too_large',
        message: 'Pasted image exceeds 3 MB limit',
      });
      return;
    }
    if (!verifyImageMagicBytes(message.mime, message.dataBase64)) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'paste_file_unsupported',
        message: 'Pasted image content does not match declared MIME type',
      });
      return;
    }
    if (!isOpen(host?.ws)) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'host_offline',
        message: 'Host is offline or disconnected',
      });
      return;
    }
    if (!client.session) {
      jsonSend(client.ws, {
        type: 'error',
        code: 'no_session',
        message: 'Terminal session is not ready',
      });
      return;
    }
    jsonSend(host.ws, {
      type: 'paste_file',
      clientId: client.session.streamId,
      streamId: client.session.streamId,
      mime: message.mime,
      dataBase64: message.dataBase64,
    });
  }
}
