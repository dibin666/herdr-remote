import { useCallback, useRef, useState } from 'react';

export function useWindowConnectionOverrides() {
  const [profileId, setProfileId] = useState<string | null>(
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('profile')
      : null,
  );
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  const clearProfileOverride = useCallback(() => {
    profileIdRef.current = null;
    setProfileId(null);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('profile')) return;
    url.searchParams.delete('profile');
    const query = url.searchParams.toString();
    window.history.replaceState({}, '', url.pathname + (query ? `?${query}` : '') + url.hash);
  }, []);

  return {
    profileId,
    requestedProfileIdRef: profileIdRef,
    clearProfileOverride,
    isAdminTerminal:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('adminTerminal') === '1',
  };
}
