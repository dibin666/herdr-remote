/**
 * Tells the connection when the page comes back to life.
 *
 * A phone that locks its screen freezes the page. When it wakes, the socket
 * may be dead without a close event ever having fired, and the reconnect
 * backoff may be halfway through a thirty-second wait. None of the page's own
 * timers notice either quickly, so the moments a person returns are hooked
 * directly: the tab becoming visible, the page restored from the back/forward
 * cache, the network coming back, the window regaining focus, and Chrome's
 * page-lifecycle `resume`.
 */
export function installWakeListeners(
  adapter: { wake(reason: string): void },
  win: Window = window,
  doc: Document = document,
): () => void {
  const wake = (reason: string) => {
    // Offline, a reconnect attempt can only fail and add to the backoff.
    if (win.navigator?.onLine === false) return;
    adapter.wake(reason);
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') wake('visible');
  };
  const onPageShow = () => wake('pageshow');
  const onOnline = () => wake('online');
  const onFocus = () => wake('focus');
  const onResume = () => wake('resume');

  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('resume', onResume);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  win.addEventListener('focus', onFocus);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('resume', onResume);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
    win.removeEventListener('focus', onFocus);
  };
}
