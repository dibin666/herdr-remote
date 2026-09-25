// What this window knows about its relay session, and how each relay event
// changes it. Pure, so the transitions can be read (and tested) in one place.

import type { ClientRole, ServerAgentStatusMessage, ServerReadyMessage } from '@protocol/messages';
import type { HostTerminalPalette } from '@protocol/terminal';
import type { ConnectionState } from '../types/connection';

export interface SessionState {
  connectionState: ConnectionState;
  stateDetail?: string;
  /** The relay's machine-readable reason for the current state, if it gave one. */
  stateCode?: string;
  role: ClientRole;
  controllerId?: string | null;
  hostId?: string;
  hostname?: string;
  assignedClientId?: string;
  /** The host terminal's own colors, or null when the host could not report them. */
  hostPalette: HostTerminalPalette | null;
  rttMs: number | null;
  /** How many windows currently connect to this host, this one included. */
  sharedWindowCount: number;
  /** Incremented when a profile/session needs the xterm buffer reset. */
  terminalResetVersion: number;
  /**
   * What the workstation's agents are doing, or null before it has said.
   * Absence is not "no agents".
   */
  agentStatus: ServerAgentStatusMessage | null;
  /**
   * Timestamp of the most recent successful pairing, or null if this session
   * has not paired. Consumers watch it to leave the pairing UI: the pairing
   * screen must not stay up once the relay has accepted the code.
   */
  lastPairedAt: number | null;
}

export const INITIAL_SESSION: SessionState = {
  connectionState: 'disconnected',
  role: 'viewer',
  hostPalette: null,
  rttMs: null,
  sharedWindowCount: 1,
  terminalResetVersion: 0,
  agentStatus: null,
  lastPairedAt: null,
};

export type SessionEvent =
  | { type: 'stateChange'; state: ConnectionState; detail?: string; code?: string }
  | { type: 'ready'; message: ServerReadyMessage; resetTerminal: boolean }
  | { type: 'hostReconnecting'; code: string; detail: string }
  | { type: 'sessionRestarted'; hostname?: string; palette?: HostTerminalPalette | null }
  | {
      type: 'roleChange';
      role: ClientRole;
      controllerId?: string | null;
      hostId?: string;
      assignedClientId?: string;
    }
  | { type: 'controlGranted' }
  | { type: 'paired'; at: number }
  | { type: 'rtt'; rttMs: number }
  | { type: 'peerCount'; count: number }
  | { type: 'sessionReady' }
  | { type: 'agentStatus'; status: ServerAgentStatusMessage }
  /** A profile switch or new connection: forget the last host, optionally its screen. */
  | { type: 'reset'; resetTerminal: boolean };

/** Everything a host told this window, forgotten while it is away. */
const HOST_PRESENTATION = {
  role: 'viewer',
  controllerId: undefined,
  hostname: undefined,
  hostPalette: null,
  rttMs: null,
  sharedWindowCount: 1,
} as const satisfies Partial<SessionState>;

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'stateChange':
      return {
        ...state,
        connectionState: event.state,
        stateCode: event.code,
        stateDetail: event.detail,
        // A count from a workstation this window is no longer talking to is
        // worse than no count: it reads as current.
        agentStatus: event.state === 'connected' ? state.agentStatus : null,
      };
    case 'ready': {
      const { message } = event;
      return {
        ...state,
        terminalResetVersion: state.terminalResetVersion + (event.resetTerminal ? 1 : 0),
        role: message.role,
        controllerId: message.controllerId,
        hostId: message.hostId,
        hostname: message.hostname,
        assignedClientId: message.clientId || state.assignedClientId,
        // The workstation tells us what its terminal looks like; nothing here
        // decides a color, and an absent palette leaves xterm on its defaults.
        hostPalette: message.terminalPalette || null,
      };
    }
    case 'hostReconnecting':
      return { ...state, ...HOST_PRESENTATION, stateCode: event.code, stateDetail: event.detail };
    case 'sessionRestarted':
      return {
        ...state,
        hostname: event.hostname,
        hostPalette: event.palette || null,
        terminalResetVersion: state.terminalResetVersion + 1,
      };
    case 'roleChange':
      return {
        ...state,
        role: event.role,
        controllerId: event.controllerId,
        hostId: event.hostId || state.hostId,
        assignedClientId: event.assignedClientId || state.assignedClientId,
      };
    case 'controlGranted':
      return { ...state, role: 'controller' };
    case 'paired':
      return { ...state, lastPairedAt: event.at };
    case 'rtt':
      return { ...state, rttMs: event.rttMs };
    case 'peerCount':
      return { ...state, sharedWindowCount: Math.max(1, event.count) };
    case 'sessionReady':
      return { ...state, connectionState: 'connected' };
    case 'agentStatus':
      return { ...state, agentStatus: event.status };
    case 'reset':
      return {
        ...state,
        ...HOST_PRESENTATION,
        hostId: undefined,
        assignedClientId: undefined,
        terminalResetVersion: state.terminalResetVersion + (event.resetTerminal ? 1 : 0),
      };
  }
}
