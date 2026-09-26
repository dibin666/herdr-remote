/**
 * The client adapter: what the relay's JSON messages mean for this window, and
 * the messages it sends. The socket underneath is `RelaySocket`.
 */

import type {
  ClientClaimControlMessage,
  ClientHelloMessage,
  ClientReleaseControlMessage,
  ClientResizeMessage,
  ClientRole,
  ServerJsonMessage,
} from '@protocol/messages';
import { RelaySocket } from './relaySocket';

export type { AdapterEventMap } from './adapterEvents';

export class HerdrClientAdapter extends RelaySocket {
  private currentRole: ClientRole = 'viewer';
  private controllerId?: string | null;
  private hostId?: string;
  private assignedClientId?: string;

  public getRole(): ClientRole {
    return this.currentRole;
  }

  public getControllerId(): string | null | undefined {
    return this.controllerId;
  }

  public getHostId(): string | undefined {
    return this.hostId;
  }

  public getAssignedClientId(): string | undefined {
    return this.assignedClientId;
  }

  protected handleServerMessage(msg: ServerJsonMessage): void {
    switch (msg.type) {
      case 'ready': {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.currentRole = msg.role;
        this.controllerId = msg.controllerId;
        this.hostId = msg.hostId;
        this.assignedClientId = msg.clientId;
        this.emit('ready', msg);
        this.emit('roleChange', msg.role, msg.controllerId, msg.hostId, msg.clientId);
        if (typeof msg.clientCount === 'number') this.emit('peerCount', msg.clientCount);
        this.emit('terminalFont', msg.terminalFont ?? null);
        break;
      }

      case 'paired': {
        this.emit('paired', {
          token: msg.token,
          deviceId: msg.deviceId,
          hostId: msg.hostId,
          expiresAt: msg.expiresAt,
        });
        break;
      }

      case 'control_state': {
        this.currentRole = msg.role;
        this.controllerId = msg.controllerId;
        this.emit('controlState', msg.role, msg.controllerId);
        this.emit('roleChange', msg.role, msg.controllerId, this.hostId, this.assignedClientId);
        if (typeof msg.clientCount === 'number') this.emit('peerCount', msg.clientCount);
        break;
      }

      case 'host_reconnecting': {
        this.temporaryFailureCode = 'host_reconnecting';
        this.setState(
          'reconnecting',
          'Herdr host is reconnecting',
          msg.code || 'host_reconnecting',
        );
        this.emit('hostReconnecting', msg.code);
        break;
      }

      case 'session_restarted': {
        this.setState('reconnecting', 'Herdr session is restarting', 'session_restarted');
        this.emit('sessionRestarted', msg.cols, msg.rows, msg.terminalPalette, msg.hostname);
        this.emit('terminalFont', msg.terminalFont ?? null);
        break;
      }

      case 'session_ready': {
        this.setState('connected');
        this.emit('sessionReady', msg);
        break;
      }

      case 'exit': {
        this.emit('exit', msg.code, msg.reason);
        break;
      }

      case 'control_granted': {
        this.currentRole = 'controller';
        this.controllerId = this.assignedClientId || this.config.clientId;
        this.emit('controlGranted');
        this.emit(
          'roleChange',
          'controller',
          this.controllerId,
          this.hostId,
          this.assignedClientId,
        );
        break;
      }

      case 'error': {
        const temporary =
          msg.code === 'host_offline' ||
          msg.code === 'host_reconnecting' ||
          msg.code === 'host_reconnect_timeout' ||
          msg.code === 'rate_limited';
        if (temporary) {
          this.temporaryFailureCode = String(msg.code);
          this.setState('reconnecting', msg.message, String(msg.code));
        } else if (
          msg.code === 'auth_required' ||
          msg.code === 'unauthorized' ||
          msg.code === 'device_revoked' ||
          msg.code === 'invalid_handshake' ||
          msg.code === 'too_many_hosts' ||
          msg.code === 401 ||
          msg.code === 403
        ) {
          this.authFailureDetail = msg.message;
          this.authFailureCode = String(msg.code);
          this.setState('error', msg.message, this.authFailureCode);
        }
        this.emit('error', { code: msg.code, message: msg.message });
        break;
      }

      case 'paste_file_ready': {
        this.emit('pasteFileReady', msg.path);
        break;
      }

      case 'agent_status': {
        this.emit('agentStatus', msg);
        break;
      }

      case 'update_status': {
        this.emit('updateStatus', msg);
        break;
      }

      case 'terminal_font': {
        this.emit('terminalFont', msg.terminalFont ?? null);
        break;
      }

      case 'host_font_chunk': {
        this.emit('hostFontChunk', msg);
        break;
      }

      case 'host_font_subset_ready': {
        this.emit('hostFontSubset', msg);
        break;
      }

      default:
        break;
    }
  }

  public sendHello(): void {
    const msg: ClientHelloMessage = {
      type: 'hello',
      protocol: 1,
      clientId: this.config.clientId,
      cols: this.terminalCols,
      rows: this.terminalRows,
      capabilities: ['host_handoff'],
    };

    if (this.config.token) {
      msg.token = this.config.token;
    }
    if (this.config.pairCode) {
      msg.pairCode = this.config.pairCode;
    }

    this.sendJson(msg);
  }

  public claimControl(force: boolean = false): void {
    const msg: ClientClaimControlMessage = {
      type: 'claim_control',
      ...(force ? { force: true } : {}),
    };
    this.sendJson(msg);
  }

  public releaseControl(): void {
    const msg: ClientReleaseControlMessage = {
      type: 'release_control',
    };
    this.sendJson(msg);
  }

  public sendResize(cols: number, rows: number): void {
    this.terminalCols = cols;
    this.terminalRows = rows;

    const msg: ClientResizeMessage = {
      type: 'resize',
      cols,
      rows,
    };
    this.sendJson(msg);
  }

  public sendPasteFile(mime: string, dataBase64: string): void {
    this.sendJson({
      type: 'paste_file',
      mime,
      dataBase64,
    });
  }

  /** One slice of an announced terminal font file, by the file's hash. */
  public sendHostFontChunkRequest(sha256: string, index: number): void {
    this.sendJson({ type: 'host_font_chunk_request', sha256, index });
  }

  /** Cut `text`'s characters out of an announced large font. */
  public sendHostFontSubsetRequest(sha256: string, text: string, requestId: string): void {
    this.sendJson({ type: 'host_font_subset_request', sha256, text, requestId });
  }

  /** Ask the workstation to read its terminal's font settings again. */
  public sendHostFontRefresh(): void {
    this.sendJson({ type: 'host_font_refresh' });
  }

  /** Ask the paired workstation to start its Herdr; see `ClientHerdrStartMessage`. */
  public sendHerdrStart(): void {
    this.sendJson({ type: 'herdr_start' });
  }
}
