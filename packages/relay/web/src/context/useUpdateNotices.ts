// Whether the workstation's herdr-remote is behind, and telling the user once.

import type { ServerUpdateStatusMessage } from '@protocol/messages';
import { type RefObject, useCallback, useRef, useState } from 'react';
import type { Translate } from '../i18n';
import { loadIgnoredUpdate, saveIgnoredUpdate } from '../utils/storage';
import type { ToastItem } from './useToastQueue';

export function useUpdateNotices(
  addToast: (type: ToastItem['type'], message: string) => void,
  tRef: RefObject<Translate>,
) {
  const [updateStatus, setUpdateStatus] = useState<ServerUpdateStatusMessage | null>(null);
  const [ignoredUpdate, setIgnoredUpdate] = useState<string | null>(loadIgnoredUpdate);
  const ignoredUpdateRef = useRef<string | null>(ignoredUpdate);
  // Announced once per page, per release: every window opening re-checks, and a
  // toast per reconnect would be the flood a status line exists to avoid.
  const announcedUpdatesRef = useRef<Set<string>>(new Set());

  /** The release the user chose to stop hearing about. */
  const ignoreUpdate = useCallback((version: string) => {
    ignoredUpdateRef.current = version;
    setIgnoredUpdate(version);
    saveIgnoredUpdate(version);
  }, []);

  const receiveUpdateStatus = useCallback(
    (status: ServerUpdateStatusMessage) => {
      setUpdateStatus(status);
      if (!status.updateAvailable || ignoredUpdateRef.current === status.latest) return;
      const key = `${status.latest}:${status.restartPending ? 'restart' : 'update'}`;
      if (announcedUpdatesRef.current.has(key)) return;
      announcedUpdatesRef.current.add(key);
      addToast(
        'info',
        status.restartPending
          ? tRef.current('update.toastRestart', { version: status.latest })
          : tRef.current('update.toast', { version: status.latest }),
      );
    },
    [addToast, tRef],
  );

  /** Another workstation may be on another release; it will say so itself. */
  const forgetUpdateStatus = useCallback(() => setUpdateStatus(null), []);

  return { updateStatus, ignoredUpdate, ignoreUpdate, receiveUpdateStatus, forgetUpdateStatus };
}
