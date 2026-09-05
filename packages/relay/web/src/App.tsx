import { useState, useEffect } from 'react';
import { TerminalProvider, useTerminal } from './context/TerminalContext';
import { Header } from './components/Header';
import { StatusBanner } from './components/StatusBanner';
import { TerminalView } from './components/TerminalView';
import { OnboardingView } from './components/OnboardingView';
import { KeyToolbar } from './components/KeyToolbar';
import { VirtualKeyboardHelper } from './components/VirtualKeyboardHelper';
import { PairingModal } from './components/PairingModal';
import { SettingsModal } from './components/SettingsModal';
import { ToastContainer } from './components/ToastContainer';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { MobileTerminalShell } from './components/MobileTerminalShell';
import { observeViewportMetrics } from './utils/viewportMetrics';
import { useMobileShell } from './utils/mobileShell';
import { attachWebUIShortcuts } from './utils/shortcuts';
import { applyDocumentTheme } from './utils/theme';

function AppContent() {
  const [currentView, setCurrentView] = useState<'terminal' | 'admin'>('terminal');
  const [isPairingOpen, setIsPairingOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVirtualKeyboardOpen, setIsVirtualKeyboardOpen] = useState(false);

  const { updateSettings, settings, connectionState, stateDetail, effectiveColorMode } = useTerminal();

  /**
   * Phones get their own shell: the terminal takes the whole screen and every
   * other control lives in an overlaid sheet. Only the chrome around the
   * terminal layer differs — the layer itself is rendered from the same place in
   * the tree either way, so crossing the breakpoint (a rotation, a resized
   * window) can never remount TerminalView and take the session with it.
   */
  const isMobileShell = useMobileShell();

  /**
   * Size the app shell from the visual viewport. `100dvh` keeps reporting the
   * full screen while the iOS soft keyboard is up, which would push the key
   * toolbar underneath it; the CSS variable this installs shrinks with the
   * keyboard so the toolbar stays reachable.
   */
  useEffect(() => observeViewportMetrics(), []);

  // Sync colorMode with documentElement class and inline background
  useEffect(() => {
    applyDocumentTheme(effectiveColorMode);
  }, [effectiveColorMode]);

  // Modal Escape key listener (scoped to open modals/sheets, strictly never intercepts Ctrl/Alt/Meta)
  useEffect(() => {
    const isAnyModalOpen = isPairingOpen || isSettingsOpen || isVirtualKeyboardOpen;
    if (!isAnyModalOpen) return;

    return attachWebUIShortcuts(
      {
        onCloseModals: () => {
          setIsPairingOpen(false);
          setIsSettingsOpen(false);
          setIsVirtualKeyboardOpen(false);
        },
      },
      { isModalOpen: isAnyModalOpen }
    );
  }, [isPairingOpen, isSettingsOpen, isVirtualKeyboardOpen]);

  // Detect URL path or hash (/admin or #admin) and query parameters on mount
  useEffect(() => {
    const handleLocationChange = () => {
      const path = window.location.pathname;
      const hash = window.location.hash;
      if (path === '/admin' || hash === '#admin') {
        setCurrentView('admin');
      } else {
        setCurrentView('terminal');
      }
    };

    handleLocationChange();
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);

    // Parse URL query params (?token=..., ?pairCode=..., ?ws=...)
    try {
      const currentUrl = new URL(window.location.href);
      const token = currentUrl.searchParams.get('token');
      const pairCode = currentUrl.searchParams.get('pairCode');
      const wsUrl = currentUrl.searchParams.get('ws') || currentUrl.searchParams.get('wsUrl');

      const updates: Partial<typeof settings> = {};
      if (token) updates.token = token;
      if (pairCode) updates.pairCode = pairCode.toUpperCase();
      if (wsUrl) updates.wsUrl = wsUrl;

      if (Object.keys(updates).length > 0) {
        updateSettings(updates);
      }

      // Remove sensitive secrets (token & pairCode) from the address bar
      let urlChanged = false;
      if (currentUrl.searchParams.has('token')) {
        currentUrl.searchParams.delete('token');
        urlChanged = true;
      }
      if (currentUrl.searchParams.has('pairCode')) {
        currentUrl.searchParams.delete('pairCode');
        urlChanged = true;
      }

      if (urlChanged) {
        const cleanSearch = currentUrl.searchParams.toString();
        const cleanUrl =
          currentUrl.pathname +
          (cleanSearch ? `?${cleanSearch}` : '') +
          currentUrl.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch (e) {
      console.warn('Failed to parse URL query params:', e);
    }

    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  const handleNavigate = (view: 'terminal' | 'admin') => {
    setCurrentView(view);
    if (view === 'admin') {
      window.history.pushState({}, '', '/admin');
    } else {
      window.history.pushState({}, '', '/');
    }
  };

  // Determine if we should show the friendly first-run onboarding screen
  const isUnpaired = !settings.token && !settings.pairCode && connectionState !== 'connected';
  const isAuthRequiredError =
    connectionState === 'error' &&
    /auth|unauthor|forbidden|permission|token|pair/i.test(stateDetail || '');
  const showOnboarding = isUnpaired || isAuthRequiredError;

  /**
   * Once the terminal has been shown, it stays mounted for the rest of the
   * session.
   */
  const [isTerminalMounted, setIsTerminalMounted] = useState(!showOnboarding);
  useEffect(() => {
    if (!showOnboarding) setIsTerminalMounted(true);
  }, [showOnboarding]);

  const isTerminalActive = currentView === 'terminal' && !showOnboarding;

  const layerVisibilityStyle = (visible: boolean) =>
    ({
      visibility: visible ? 'visible' : 'hidden',
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      zIndex: visible ? 1 : 0,
    }) as const;

  return (
    <div
      data-testid="app-shell"
      style={
        isMobileShell
          ? {
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
              paddingLeft: 'env(safe-area-inset-left, 0px)',
              paddingRight: 'env(safe-area-inset-right, 0px)',
            }
          : undefined
      }
      className="flex flex-col h-full w-full bg-sand-100 dark:bg-charcoal-950 text-charcoal-900 dark:text-charcoal-100 overflow-hidden select-none transition-colors"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Top Header — desktop only; the phone shell folds this into its sheet */}
      {!isMobileShell && (
        <Header
          currentView={currentView}
          onNavigate={handleNavigate}
          onOpenPairing={() => setIsPairingOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onToggleVirtualKeyboard={() => setIsVirtualKeyboardOpen(!isVirtualKeyboardOpen)}
          isVirtualKeyboardOpen={isVirtualKeyboardOpen}
        />
      )}

      {/* Global Connection / Reconnect Banner */}
      {!isMobileShell && !showOnboarding && <StatusBanner />}

      {/* Main View Area — layers are stacked, never swapped, so the terminal survives navigation */}
      <div className="flex-1 min-h-0 w-full overflow-hidden relative">
        {/* Terminal layer (keep-alive) */}
        {isTerminalMounted && (
          <div
            data-testid="terminal-layer"
            className={`absolute ${isMobileShell ? 'inset-x-0 top-12 bottom-0' : 'inset-0'} flex flex-col min-h-0 w-full overflow-hidden`}
            style={layerVisibilityStyle(isTerminalActive)}
            aria-hidden={!isTerminalActive}
          >
            <TerminalView isActive={isTerminalActive} />
            {!isMobileShell && (
              <VirtualKeyboardHelper
                isOpen={isVirtualKeyboardOpen}
                onClose={() => setIsVirtualKeyboardOpen(false)}
              />
            )}
            <KeyToolbar compact={isMobileShell} />
          </div>
        )}

        {/* Onboarding layer */}
        {currentView === 'terminal' && showOnboarding && (
          <div
            data-testid="onboarding-layer"
            className="absolute inset-0 flex flex-col min-h-0 w-full overflow-hidden z-10"
          >
            <OnboardingView onPairedSuccess={() => {}} />
          </div>
        )}

        {/* Admin layer — mounted on demand so /api/status is not polled from the terminal view */}
        {currentView === 'admin' && (
          <div
            data-testid="admin-layer"
            className="absolute inset-0 flex flex-col min-h-0 w-full overflow-hidden z-20"
          >
            <AdminDashboard
              onBackToTerminal={() => handleNavigate('terminal')}
              onOpenPairing={() => setIsPairingOpen(true)}
            />
          </div>
        )}

        {/* Phone chrome: a reserved top bar plus an overlaid control sheet */}
        {isMobileShell && isTerminalActive && (
          <MobileTerminalShell
            onNavigateAdmin={() => handleNavigate('admin')}
            onOpenPairing={() => setIsPairingOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
      </div>

      {/* Modals & Floating Overlays */}
      <PairingModal isOpen={isPairingOpen} onClose={() => setIsPairingOpen(false)} />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      <ToastContainer />
    </div>
  );
}

export function App() {
  return (
    <TerminalProvider>
      <AppContent />
    </TerminalProvider>
  );
}

export default App;
