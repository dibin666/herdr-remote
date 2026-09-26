// Saved settings and the connection profiles in them: adding, switching,
// renaming and removing profiles, and recording what pairing and the relay
// taught this window about each one.

import { WS_CLIENT_PATH } from '@protocol/messages';
import { useCallback, useRef, useState } from 'react';
import { loadSettings, type StoredSettings, saveSettings } from '../utils/storage';
import {
  type ConnectionProfile,
  createConnectionProfile,
  profileKey,
} from '../utils/connectionProfiles';

export interface PairingResult {
  token: string;
  hostId?: string;
  deviceId?: string;
  expiresAt?: number | string;
}

/**
 * `onActiveProfileChanged` runs after the active profile changes to another
 * relay or host, with the settings now saved: the window has to drop what the
 * old one showed and connect to the new one.
 */
export function useProfiles(onActiveProfileChanged: (next: StoredSettings) => void) {
  const [settings, setSettingsState] = useState<StoredSettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangedRef = useRef(onActiveProfileChanged);
  onChangedRef.current = onActiveProfileChanged;

  const updateSettings = useCallback((partial: Partial<StoredSettings>) => {
    const updated = saveSettings(partial);
    settingsRef.current = updated;
    setSettingsState(updated);
  }, []);

  const applySavedSettings = useCallback((next: StoredSettings) => {
    // Keep the ref current immediately: pairing and reconnect events can arrive
    // before React has committed the next render.
    settingsRef.current = next;
    setSettingsState(next);
  }, []);

  const addProfileAndConnect = useCallback(
    (draft: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'wsUrl'>) => {
      const current = settingsRef.current;
      const profile = createConnectionProfile(
        {
          ...draft,
          wsUrl: draft.wsUrl || WS_CLIENT_PATH,
          token: draft.token || '',
          displayName: draft.displayName || `Herdr ${current.profiles.length + 1}`,
          autoReconnect: draft.autoReconnect !== false,
        },
        current.profiles.length,
      );
      const next = saveSettings({
        profiles: [...current.profiles, profile],
        activeProfileId: profile.id,
        wsUrl: profile.wsUrl,
        token: profile.token,
        pairCode: profile.pairCode || '',
        autoReconnect: profile.autoReconnect,
      });
      applySavedSettings(next);
      onChangedRef.current(next);
    },
    [applySavedSettings],
  );

  const switchProfile = useCallback(
    (profileId: string) => {
      const current = settingsRef.current;
      const target = current.profiles.find((profile) => profile.id === profileId);
      if (!target || target.id === current.activeProfileId) return;
      const next = saveSettings({
        activeProfileId: target.id,
        wsUrl: target.wsUrl,
        token: target.token,
        pairCode: target.pairCode || '',
        autoReconnect: target.autoReconnect,
        profiles: current.profiles.map((profile) =>
          profile.id === target.id ? { ...profile, lastUsedAt: Date.now() } : profile,
        ),
      });
      applySavedSettings(next);
      onChangedRef.current(next);
    },
    [applySavedSettings],
  );

  const renameProfile = useCallback(
    (profileId: string, displayName: string) => {
      const current = settingsRef.current;
      const profile = current.profiles.find((item) => item.id === profileId);
      if (!profile) return;
      const trimmed = displayName.trim().slice(0, 64);
      if (!trimmed) return;
      const next = saveSettings({
        profiles: current.profiles.map((item) =>
          item.id === profileId ? { ...item, displayName: trimmed } : item,
        ),
      });
      applySavedSettings(next);
    },
    [applySavedSettings],
  );

  const removeProfile = useCallback(
    (profileId: string) => {
      const current = settingsRef.current;
      if (!current.profiles.some((profile) => profile.id === profileId)) return;
      const remaining = current.profiles.filter((profile) => profile.id !== profileId);
      const nextActive =
        remaining.find((profile) => profile.id === current.activeProfileId) || remaining[0];
      const next = nextActive
        ? saveSettings({
            profiles: remaining,
            activeProfileId: nextActive.id,
            wsUrl: nextActive.wsUrl,
            token: nextActive.token,
            pairCode: nextActive.pairCode || '',
            autoReconnect: nextActive.autoReconnect,
          })
        : saveSettings({
            profiles: [],
            activeProfileId: '',
            wsUrl: WS_CLIENT_PATH,
            token: '',
            pairCode: '',
          });
      applySavedSettings(next);
      if (profileId === current.activeProfileId) onChangedRef.current(next);
    },
    [applySavedSettings],
  );

  /** Keep a new device token in the profile that paired, and return the saved settings. */
  const savePairedProfile = useCallback(
    (payload: PairingResult) => {
      const current = settingsRef.current;
      const active = current.profiles.find((profile) => profile.id === current.activeProfileId);
      const key = payload.hostId
        ? profileKey({ wsUrl: current.wsUrl, hostId: payload.hostId })
        : null;
      const matchIndex = key
        ? current.profiles.findIndex((profile) => profileKey(profile) === key)
        : -1;
      const targetIndex =
        matchIndex >= 0
          ? matchIndex
          : Math.max(
              0,
              current.profiles.findIndex((profile) => profile.id === current.activeProfileId),
            );
      const base =
        current.profiles[targetIndex] ||
        active ||
        createConnectionProfile(
          {
            wsUrl: current.wsUrl || WS_CLIENT_PATH,
            token: '',
            pairCode: current.pairCode || 'PENDING',
            displayName: `Herdr ${current.profiles.length + 1}`,
          },
          current.profiles.length,
        );
      const updated: ConnectionProfile = {
        ...base,
        token: payload.token,
        pairCode: undefined,
        ...(payload.hostId ? { hostId: payload.hostId } : {}),
        ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
        lastUsedAt: Date.now(),
      };
      let profiles = [...current.profiles];
      if (targetIndex >= 0 && targetIndex < profiles.length) profiles[targetIndex] = updated;
      else profiles.push(updated);
      // If re-pairing found an older profile, remove the temporary pending one
      // that initiated this flow while preserving the older profile's alias.
      const pendingId = active?.id;
      profiles = profiles.filter((profile, index) => {
        if (index === targetIndex || profile.id === updated.id) return true;
        if (matchIndex >= 0 && pendingId && profile.id === pendingId) return false;
        return true;
      });
      const next = saveSettings({
        profiles,
        activeProfileId: updated.id,
        wsUrl: updated.wsUrl,
        token: updated.token,
        pairCode: '',
        autoReconnect: updated.autoReconnect,
      });
      applySavedSettings(next);
      return next;
    },
    [applySavedSettings],
  );

  /** Name the active profile after the host it reached, unless the user named it. */
  const noteReadyProfile = useCallback(
    (ready: { hostId?: string; hostname?: string }) => {
      const current = settingsRef.current;
      const active = current.profiles.find((profile) => profile.id === current.activeProfileId);
      if (!active || (!ready.hostId && !ready.hostname)) return;
      const fallbackName = /^Herdr \d+$/.test(active.displayName);
      const updated = {
        ...active,
        ...(ready.hostId ? { hostId: ready.hostId } : {}),
        ...(ready.hostname ? { hostname: ready.hostname } : {}),
        ...(ready.hostname && fallbackName ? { displayName: ready.hostname } : {}),
      };
      const next = saveSettings({
        profiles: current.profiles.map((profile) => (profile.id === active.id ? updated : profile)),
      });
      applySavedSettings(next);
    },
    [applySavedSettings],
  );

  return {
    settings,
    updateSettings,
    addProfileAndConnect,
    switchProfile,
    renameProfile,
    removeProfile,
    savePairedProfile,
    noteReadyProfile,
  };
}
