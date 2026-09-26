/** What a keep-alive manager reports about the installed service. */
export interface KeepaliveStatus {
  manager: 'systemd' | 'launchd' | 'supervisor' | 'none';
  installed: boolean;
  active: boolean;
  enabled: boolean;
  /** systemd only: whether the user's services outlive their login session. */
  linger?: boolean;
  pid?: number | null;
  /** The unit file, plist or pid file behind the service. */
  unitPath?: string;
  state?: string;
}

/** One way of keeping the services running; each platform manager is one. */
export interface KeepaliveBackend {
  readonly name: 'systemd' | 'launchd' | 'supervisor';
  status(): KeepaliveStatus;
  install(): { ok: true; [key: string]: unknown };
  uninstall(): { ok: true; [key: string]: unknown };
  /** Restart the services, so config edits take effect. */
  restart(): { ok: true; [key: string]: unknown };
  /** Stop the services without uninstalling them. */
  stop(): void;
  /** The command that follows the services' log. */
  logsHint(): string;
}
