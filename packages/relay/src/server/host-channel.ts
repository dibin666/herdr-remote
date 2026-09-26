// The host side of the relay: a workstation's WebSocket, from its hello and
// the hand-off from an older connection to every message it sends after.

import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import type { RawData } from 'ws';
import {
  CAPABILITY,
  type HostHelloMessage,
  type HostMessage,
  PROTOCOL_VERSION,
  sanitizeTerminalFont,
  sanitizeTerminalPalette,
  unpackStreamFrame,
} from '../protocol/index.js';
import {
  forwardFontChunk,
  forwardFontSubset,
  settleFontChunk,
  settleFontSubset,
} from './font-proxy.js';
import {
  broadcastAgentStatus,
  broadcastTerminalFont,
  broadcastUpdateStatus,
} from './host-broadcasts.js';
import { allowHostHandshake } from './requests.js';
import {
  beginHostReconnect,
  canHandoffHost,
  detachClient,
  detachHost,
  releaseSession,
  startSession,
} from './sessions.js';
import { closeSocket, isOpen, jsonSend, parseJson, randomId, rejectHandshake } from './sockets.js';
import { broadcastToClients, notifyHostClientCount, sendClientBinary } from './transport.js';
import type { RelayContext, RelayHost, RelaySocket } from './types.js';

/** A host socket between its connection and its hello, and the record after. */
interface PendingHost {
  ws: RelaySocket;
  remoteAddress: string | undefined;
  connectedAt: number;
  authenticated: boolean;
  host?: RelayHost;
}

function createHostRecord(
  message: HostHelloMessage,
  ws: RelaySocket,
  pending: PendingHost,
  clients = new Set<string>(),
): RelayHost {
  const capabilities: unknown[] = Array.isArray(message.capabilities) ? message.capabilities : [];
  return {
    id: message.hostId,
    ws,
    hostname: typeof message.hostname === 'string' ? message.hostname.slice(0, 128) : os.hostname(),
    platform:
      typeof message.platform === 'string' ? message.platform.slice(0, 32) : process.platform,
    arch: typeof message.arch === 'string' ? message.arch.slice(0, 32) : process.arch,
    connectedAt: new Date(pending.connectedAt).toISOString(),
    connectedAtMs: pending.connectedAt,
    terminalPalette: sanitizeTerminalPalette(message.terminalPalette),
    /** Family, size and fetchable files of the workstation's terminal font. */
    terminalFont: sanitizeTerminalFont(message.terminalFont),
    /** The latest workstation snapshot is replayed when a browser joins late. */
    agentStatus: null,
    /** Whether the workstation's herdr-remote is behind; replayed the same way. */
    updateStatus: null,
    lastSeenAt: Date.now(),
    clients,
    controllerId: null,
    load: {},
    ptys: [],
    reconnecting: false,
    reconnectTimer: null,
    connectionGeneration: randomId('host-connection'),
    handoffCapable: capabilities.includes(CAPABILITY.hostHandoff),
    binaryFrameV2: capabilities.includes(CAPABILITY.binaryFrameV2),
    streamIndices: new Map(),
    nextStreamIndex: 0,
    shutdownRequested: false,
  };
}

export function handleHostConnection(
  relay: RelayContext,
  ws: RelaySocket,
  req: IncomingMessage,
): void {
  const pending: PendingHost = {
    ws,
    remoteAddress: req.socket.remoteAddress,
    connectedAt: Date.now(),
    authenticated: false,
  };
  const deadline = setTimeout(() => {
    if (!pending.authenticated) closeSocket(ws, 1008, 'host hello timeout');
  }, 10000);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (pending.host) pending.host.lastSeenAt = Date.now();
  });
  ws.on('ping', () => {
    ws.isAlive = true;
    if (pending.host) pending.host.lastSeenAt = Date.now();
  });
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (!pending.authenticated) {
      if (isBinary) return rejectHandshake(ws, 'host hello must be JSON');
      const message = parseJson<HostHelloMessage>(raw.toString());
      if (message?.type !== 'host_hello' || message.protocol !== PROTOCOL_VERSION)
        return rejectHandshake(ws, 'invalid host hello');
      if (!allowHostHandshake(relay, req))
        return rejectHandshake(ws, 'too many connection attempts', 'rate_limited');
      const oldHost = relay.hosts.get(message.hostId);
      if (!oldHost && relay.hosts.size >= relay.config.relay.maxHosts) {
        return rejectHandshake(ws, 'relay host limit reached', 'too_many_hosts');
      }
      const registration = relay.auth.registerHost(
        message.hostId,
        message.token,
        message.password ?? null,
      );
      if (!registration.ok) return rejectHandshake(ws, registration.message, registration.code);
      clearTimeout(deadline);
      pending.authenticated = true;
      relay.finishHandshake(ws);

      const handoff = canHandoffHost(relay, oldHost);
      const retainedClients = handoff && oldHost ? oldHost.clients : new Set<string>();
      if (oldHost) {
        if (oldHost.reconnectTimer) clearTimeout(oldHost.reconnectTimer);
        oldHost.reconnectTimer = null;
        if (handoff) {
          for (const clientId of oldHost.clients) {
            const client = relay.clients.get(clientId);
            if (client?.session) {
              if (isOpen(oldHost.ws)) {
                jsonSend(oldHost.ws, {
                  type: 'session_stop',
                  clientId: client.session.streamId,
                  streamId: client.session.streamId,
                });
              }
              releaseSession(relay, oldHost, client);
            }
          }
          oldHost.load = {};
          oldHost.ptys = [];
          broadcastToClients(relay, oldHost, () => ({
            type: 'host_reconnecting',
            code: 'host_replaced',
          }));
        } else {
          detachHost(relay, oldHost, { notify: true, reason: 'host_replaced' });
        }
      }

      const host = createHostRecord(message, ws, pending, retainedClients);
      pending.host = host;
      // Install the new record before closing the old socket. Its delayed
      // close handler then fails the identity check instead of detaching the
      // freshly authenticated host.
      relay.hosts.set(host.id, host);
      if (oldHost && handoff) closeSocket(oldHost.ws, 1000, 'host_replaced');
      jsonSend(ws, {
        type: 'host_ready',
        protocol: PROTOCOL_VERSION,
        hostId: host.id,
        clientCount: host.clients.size,
      });
      notifyHostClientCount(host);
      if (handoff) {
        for (const clientId of host.clients) {
          const client = relay.clients.get(clientId);
          if (client) startSession(relay, host, client, { restarted: true });
        }
      }
      return;
    }
    if (pending.host) handleHostMessage(relay, pending.host, raw, isBinary);
  });
  ws.on('close', (_code: number, rawReason: Buffer) => {
    clearTimeout(deadline);
    const host = pending.host;
    if (!host || relay.hosts.get(host.id) !== host || host.ws !== ws) return;
    const reason = rawReason ? rawReason.toString() : '';
    if (reason === 'host_shutdown') host.shutdownRequested = true;
    if (host.shutdownRequested || !canHandoffHost(relay, host)) {
      detachHost(relay, host, {
        notify: true,
        reason: host.shutdownRequested ? 'host_shutdown' : 'host_disconnected',
      });
      return;
    }
    beginHostReconnect(relay, host, 'host_disconnected');
  });
  ws.on('error', () => {});
}

function handleHostMessage(
  relay: RelayContext,
  host: RelayHost,
  raw: RawData,
  isBinary: boolean,
): void {
  host.lastSeenAt = Date.now();
  if (isBinary) {
    let frame: ReturnType<typeof unpackStreamFrame>;
    try {
      frame = unpackStreamFrame(raw as Buffer);
    } catch (error) {
      relay.metrics.recordCleanup('deadConnectionsClosed');
      closeSocket(host.ws, 1003, (error as Error).message);
      return;
    }
    // Postel's law: be conservative in what you send, liberal in what you accept.
    // We strictly send v2 only to hosts that negotiated binary_frame_v2, but we accept
    // both v1 and v2 on receipt: a v2-capable host falls back to v1 if stream indices
    // were exhausted for a session, and an unnegotiated host sending v2 simply finds
    // no routed client instead of having its entire connection severed.
    // Output is routed to the single client owning the stream rather than broadcast.
    if (frame.type !== 'output') return;
    const clientId =
      frame.version === 2
        ? host.streamIndices.get(frame.streamIndex)
        : relay.streams.get(frame.streamId);
    if (!clientId) return;
    const client = relay.clients.get(clientId);
    if (!client || !isOpen(client.ws)) return;
    sendClientBinary(relay, host, client, frame.payload);
    return;
  }
  // Untrusted: each branch reads only the fields its message type defines.
  const message = parseJson<HostMessage>(raw.toString());
  if (!message) return;
  if (message.type === 'heartbeat') {
    host.load = message.load && typeof message.load === 'object' ? message.load : {};
    host.ptys = Array.isArray(message.ptys) ? message.ptys.slice(0, 256) : [];
    return;
  }
  if (message.type === 'host_shutdown') {
    host.shutdownRequested = true;
    if (relay.hosts.get(host.id) === host)
      detachHost(relay, host, { notify: true, reason: 'host_shutdown' });
    return;
  }
  // What the workstation's agents are doing belongs to the workstation, not
  // to one stream: every window watching it gets the same answer.
  if (message.type === 'agent_status') {
    broadcastAgentStatus(relay, host, message);
    return;
  }
  if (message.type === 'update_status') {
    broadcastUpdateStatus(relay, host, message);
    return;
  }
  if (message.type === 'terminal_font') {
    broadcastTerminalFont(relay, host, message);
    return;
  }
  // Session events target the single client that owns this stream.
  const addressed = message as { clientId?: unknown; streamId?: unknown };
  const streamId =
    typeof addressed.clientId === 'string'
      ? addressed.clientId
      : (addressed.streamId as string | undefined);
  const clientId = streamId ? relay.streams.get(streamId) : null;
  const client = clientId ? relay.clients.get(clientId) : null;
  if (!client) return;

  if (message.type === 'session_ready') {
    if (client.session) client.session.ready = true;
    jsonSend(client.ws, { type: 'session_ready', clientId: client.id });
  } else if (message.type === 'session_exit') {
    const code = Number.isInteger(message.code) ? message.code : null;
    jsonSend(client.ws, { type: 'exit', code });
    releaseSession(relay, host, client);
    detachClient(relay, client, { notify: false });
  } else if (message.type === 'host_font_chunk') {
    forwardFontChunk(client, message);
  } else if (message.type === 'host_font_subset_ready') {
    forwardFontSubset(client, message);
  } else if (message.type === 'paste_file_ready') {
    jsonSend(client.ws, {
      type: 'paste_file_ready',
      path: message.path,
    });
  } else if (message.type === 'error') {
    if (message.code === 'host_font_unavailable') {
      settleFontChunk(client);
      settleFontSubset(client);
    }
    if (message.code === 'host_font_subset_failed') settleFontSubset(client);
    jsonSend(client.ws, {
      type: 'error',
      code: message.code || 'host_error',
      message: String(message.message || 'Host connector error'),
    });
  }
}
