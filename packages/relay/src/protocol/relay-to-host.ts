// Everything the relay tells the host connector: the handshake answer, the
// browser-count telemetry, and the per-window requests the host answers —
// sessions, resizes, fonts, paste files, clipboard replies, fs work.
// Stream-addressed messages carry `clientId`/`streamId` naming their window,
// exactly as `StreamAddressed` in ./messages declares.

import type * as Clipboard from './clipboard.js';
import type * as Fs from './files.js';
import type { ClientRole, PaneActionKind, StreamAddressed } from './messages.js';

export interface RelayHostReadyMessage {
  type: 'host_ready';
  protocol: 1;
  hostId: string;
  clientCount: number;
  /** What this relay does for hosts; older relays leave it out. */
  capabilities?: string[];
}

/** How many browsers watch; the host stops its telemetry at zero. */
export interface RelayClientCountMessage {
  type: 'client_count';
  clientCount: number;
}

export interface RelaySessionStartMessage extends StreamAddressed {
  type: 'session_start';
  cols: number;
  rows: number;
  role: ClientRole;
  /** Present when the host negotiated v2 frames and an index was free. */
  streamIndex?: number;
}

export interface RelaySessionStopMessage extends StreamAddressed {
  type: 'session_stop';
}

export interface RelayResizeMessage extends StreamAddressed {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface RelayHerdrStartMessage extends StreamAddressed {
  type: 'herdr_start';
}

export interface RelayAdminTabOpenMessage extends StreamAddressed {
  type: 'admin_tab_open';
}

/** One canned action a window asked for on a pane of this workstation's Herdr. */
export interface RelayPaneActionMessage extends StreamAddressed {
  type: 'pane_action';
  paneId: string;
  action: PaneActionKind;
}

export interface RelayHostFontRefreshMessage extends StreamAddressed {
  type: 'host_font_refresh';
}

export interface RelayHostFontChunkRequestMessage extends StreamAddressed {
  type: 'host_font_chunk_request';
  sha256: string;
  index: number;
}

export interface RelayHostFontSubsetRequestMessage extends StreamAddressed {
  type: 'host_font_subset_request';
  requestId: string;
  sha256: string;
  text: string;
}

export interface RelayPasteFileMessage extends StreamAddressed {
  type: 'paste_file';
  mime: string;
  dataBase64: string;
  /** Sanitized file name, present only when `mime` is `PASTE_FILE_MIME`. */
  name?: string;
}

/** A window's announced upload, after the relay checked it. */
export interface RelayPasteFileBeginMessage extends StreamAddressed {
  type: 'paste_file_begin';
  requestId: string;
  mime: string;
  /** Sanitized file name, present only when `mime` is `PASTE_FILE_MIME`. */
  name?: string;
  size: number;
}

/** One slice the host asked for, answered by the window. */
export interface RelayPasteFileChunkMessage extends StreamAddressed {
  type: 'paste_file_chunk';
  requestId: string;
  index: number;
  dataBase64: string;
}

/** Sent instead of `host_ready` when the handshake is refused. */
export interface RelayErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type RelayToHostMessage =
  | RelayHostReadyMessage
  | RelayClientCountMessage
  | RelaySessionStartMessage
  | RelaySessionStopMessage
  | RelayResizeMessage
  | RelayHerdrStartMessage
  | RelayAdminTabOpenMessage
  | RelayPaneActionMessage
  | RelayHostFontRefreshMessage
  | RelayHostFontChunkRequestMessage
  | RelayHostFontSubsetRequestMessage
  | RelayPasteFileMessage
  | RelayPasteFileBeginMessage
  | RelayPasteFileChunkMessage
  | Fs.RelayFsListRequestMessage
  | Fs.RelayFsDownloadRequestMessage
  | Fs.RelayFsDownloadChunkRequestMessage
  | Fs.RelayFsPreviewRequestMessage
  | Fs.RelayFsRenameRequestMessage
  | Fs.RelayFsDeleteRequestMessage
  | Clipboard.RelayClipboardReadReplyMessage
  | RelayErrorMessage;
