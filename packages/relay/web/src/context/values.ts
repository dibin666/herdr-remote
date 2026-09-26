// What each of the terminal contexts provides; see TerminalContext.tsx.

import type {
  ClientRole,
  ServerAgentStatusMessage,
  ServerUpdateStatusMessage,
} from '@protocol/messages';
import type { HostTerminalPalette } from '@protocol/terminal';
import type { Language, Translate } from '@/shared/i18n';
import type { HerdrClientAdapter } from '@/connection/clientAdapter';
import type { KeyModifiers } from '@/shared/keys/keyEncoder';
import type { ConnectionConfig, ConnectionState } from '@/connection/types';
import type { AgentProfileId } from '@/features/agents/agentKeymaps';
import type { ImageUploadProgress, PreparedImagePaste } from '@/features/paste/imagePaste';
import type { StoredSettings } from '@/features/settings/storage';
import type { ConnectionProfile } from '@/features/pairing/connectionProfiles';
import type { HostFontState } from '@/features/hostFont/hostFontState';
import type { HerdrLaunchState } from './useHerdrLaunch';
import type { TerminalOutputSink } from './useOutputBuffer';
import type { ModifierLatch } from './useTerminalInput';
import type { ToastItem } from './useToastQueue';

export interface SettingsContextValue {
  settings: StoredSettings;
  updateSettings: (partial: Partial<StoredSettings>) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translate;
  profiles: ConnectionProfile[];
  activeProfileId: string;
  activeProfile?: ConnectionProfile;
  switchProfile: (profileId: string) => void;
  addProfileAndConnect: (
    profile: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'wsUrl'>,
  ) => void;
  renameProfile: (profileId: string, displayName: string) => void;
  removeProfile: (profileId: string) => void;
  /** The workstation terminal's font, and whether this window can draw it. */
  hostFont: HostFontState;
  /** Fetch the host's font files (asked once per font, remembered per host). */
  loadHostFont: () => void;
  /** Keep this device's own fonts for the current host font. */
  declineHostFont: () => void;
  /** Have the host re-read its terminal's font, and load what it reports. */
  syncHostFont: () => void;
  /** Characters about to be drawn; fetches any the host's cut font should supply. */
  ensureHostGlyphs: (text: string) => void;
  /** The CSS font-family list the terminal and the interface draw with. */
  terminalFontFamily: string;
  /** The terminal's base size in CSS pixels, before small-screen fitting. */
  terminalFontSize: number;
}

export interface ConnectionContextValue {
  connectionState: ConnectionState;
  stateDetail?: string;
  /** The relay's machine-readable reason for the current state, if it gave one. */
  stateCode?: string;
  role: ClientRole;
  controllerId?: string | null;
  hostId?: string;
  hostname?: string;
  assignedClientId?: string;
  isController: boolean;
  /** How many windows currently connect to this host, this one included. */
  sharedWindowCount: number;
  /** Incremented when a profile/session needs the xterm buffer reset. */
  terminalResetVersion: number;
  rttMs: number | null;
  /**
   * What the workstation's agents are doing, or null before it has said.
   * Read from Herdr's socket API by the host connector, not from the terminal.
   */
  agentStatus: ServerAgentStatusMessage | null;
  /** Keymap resolved automatically from the workstation's focused pane. */
  agentProfile: AgentProfileId;
  /**
   * Timestamp of the most recent successful pairing, or null if this session
   * has not paired. Consumers watch it to leave the pairing UI.
   */
  lastPairedAt: number | null;
  /** The host terminal's own colors, or null when the host could not report them. */
  hostPalette: HostTerminalPalette | null;
  adapter: HerdrClientAdapter | null;
  connect: (overrideConfig?: Partial<ConnectionConfig>) => void;
  disconnect: () => void;
  claimControl: (force?: boolean) => void;
  releaseControl: () => void;
  herdrLaunch: HerdrLaunchState | null;
  /** Ask the paired workstation to start its Herdr. */
  startHerdr: () => void;
  /** Whether the workstation's herdr-remote is behind, or null until it says. */
  updateStatus: ServerUpdateStatusMessage | null;
  /** The release the user chose to stop hearing about. */
  ignoredUpdate: string | null;
  ignoreUpdate: (version: string) => void;
}

export interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (type: ToastItem['type'], message: string) => void;
  removeToast: (id: string) => void;
}

export interface TerminalIOContextValue {
  terminalDimensions: { cols: number; rows: number };
  sendKey: (rawKey: string) => void;
  /** See every key the on-screen toolbars send, before it goes out. */
  observeKeyInput: (observer: (bytes: Uint8Array) => void) => () => void;
  /** Ctrl, Alt and Shift latched on the key bar, for the next key from anywhere. */
  modifierLatch: ModifierLatch;
  toggleModifierLatch: (modifier: keyof ModifierLatch) => void;
  /** Takes the latched modifiers for the key being sent, and releases them. */
  consumeModifierLatch: () => KeyModifiers | null;
  sendBinary: (data: Uint8Array | ArrayBuffer) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Say, once per stretch of viewer role, that this window cannot type. */
  warnViewerMode: () => void;
  sendPasteFile: (mime: string, dataBase64: string) => boolean;
  subscribeToPasteFileReady: (handler: (path: string) => void) => () => void;
  /** Attach the terminal as the output sink; buffered output is replayed first. */
  subscribeToOutput: (sink: TerminalOutputSink) => () => void;
  /** Number of chunks currently buffered (diagnostics / tests). */
  getPendingOutputChunkCount: () => number;
}

export interface UploadContextValue {
  uploadProgress: ImageUploadProgress;
  uploadImage: (file: Blob | File | PreparedImagePaste) => Promise<boolean>;
  resetUploadProgress: () => void;
}

export type TerminalContextValue = SettingsContextValue &
  ConnectionContextValue &
  ToastContextValue &
  TerminalIOContextValue &
  UploadContextValue;
