// Everything that can change the terminal's box or bring the page back:
// the container resizing, the window, rotation, the visual viewport (pinch,
// on-screen keyboard), and the page returning from the background.

/** Listen for box changes; returns what stops listening. */
export function attachViewportListeners(
  container: HTMLElement,
  {
    requestFit,
    onPageVisible,
  }: {
    /** Refit on the next frame; bursts coalesce. */
    requestFit: () => void;
    /** The page came back from the background: re-measure and repaint. */
    onPageVisible: () => void;
  },
): () => void {
  // Resize observer on terminal container — this is the valid source of container physical size changes
  const resizeObserver = new ResizeObserver(() => {
    requestFit();
  });
  resizeObserver.observe(container);

  const handleWindowResize = () => {
    requestFit();
  };

  // Page visibility change recovery: re-measure and repaint after backgrounding
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') onPageVisible();
  };

  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('orientationchange', handleWindowResize);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handleVisibilityChange);

  // Visual viewport pinch scale / zoom listener for renderer refresh
  const handleVisualViewport = () => {
    requestFit();
  };
  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleVisualViewport);
    window.visualViewport.addEventListener('scroll', handleVisualViewport);
  }

  return () => {
    resizeObserver.disconnect();
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('orientationchange', handleWindowResize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pageshow', handleVisibilityChange);
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', handleVisualViewport);
      window.visualViewport.removeEventListener('scroll', handleVisualViewport);
    }
  };
}
