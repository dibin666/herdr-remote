import { useState, useEffect } from 'react';
import { TerminalProvider, useSettings, useConnection } from '@/context/TerminalContext';
import { useAgentAlerts } from '@/features/agents/useAgentAlerts';
import { Header } from './Header';
import { StatusBanner } from '@/features/status/StatusBanner';
import { TerminalView } from '@/features/terminal/TerminalView';
import { OnboardingView } from '@/features/pairing/OnboardingView';
import { KeyToolbar } from '@/features/keyboard/KeyToolbar';
import { VirtualKeyboardHelper } from '@/features/keyboard/VirtualKeyboardHelper';
import { PairingModal } from '@/features/pairing/PairingModal';
import { SettingsModal, type SettingsTab } from '@/features/settings/SettingsModal';
import { ToastContainer } from './ToastContainer';
import { SessionStatusLine } from '@/features/status/SessionStatusLine';
import { AdminDashboard } from '@/features/admin/AdminDashboard';
import { MobileTerminalShell } from '@/features/mobile/MobileTerminalShell';
import { HerdrStartPrompt } from '@/features/status/HerdrStartPrompt';
import { HostFontPrompt } from '@/features/hostFont/HostFontPrompt';
import { observeViewportMetrics } from './viewportMetrics';
import { useMobileShell } from '@/features/mobile/mobileShell';
import { attachWebUIShortcuts } from './shortcuts';
import { applyDocumentTheme } from '@/features/terminal/theme';

function AppContent() {
  const [currentView, setCurrentView] = useState<'terminal' | 'admin'>('terminal');
  const [isPairingOpen, setIsPairingOpen] = useState(false);
  const [isPairingAddMode, setIsPairingAddMode] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const openSettings = (tab?: SettingsTab) => {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  };
  const [isVirtualKeyboardOpen, setIsVirtualKeyboardOpen] = useState(false);

  const { updateSettings, settings } = useSettings();

  const { connectionState, stateDetail, stateCode, lastPairedAt } = useConnection();
  useAgentAlerts();

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

  // Keep the dark-only document shell in sync before/after the app mounts
  useEffect(() => {
    applyDocumentTheme();
  }, []);

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
      { isModalOpen: isAnyModalOpen },
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

    // Only a pairing code is taken from a link. A relay address (?ws=) or a
    // device token (?token=) would let whoever wrote the link send this
    // browser's saved token to their own server, or swap in their own device.
    try {
      const currentUrl = new URL(window.location.href);
      const pairCode = currentUrl.searchParams.get('pairCode');
      if (pairCode) updateSettings({ pairCode: pairCode.toUpperCase() });

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
          currentUrl.pathname + (cleanSearch ? `?${cleanSearch}` : '') + currentUrl.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch (e) {
      console.warn('Failed to parse URL query params:', e);
    }

    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, [updateSettings]);

  const openPairing = (addNew = false) => {
    setIsPairingAddMode(addNew);
    setIsPairingOpen(true);
  };

  const closePairing = () => {
    setIsPairingOpen(false);
    setIsPairingAddMode(false);
  };

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
  // The relay's reason code is the reliable signal; the sentence is matched
  // only for relays too old to send one, and would not match at all once it has
  // been translated out of English.
  const isAuthRequiredError =
    connectionState === 'error' &&
    (['auth_required', 'unauthorized', 'device_revoked'].includes(stateCode || '') ||
      /auth|unauthor|forbidden|permission|token|pair/i.test(stateDetail || ''));
  const showOnboarding = isUnpaired || isAuthRequiredError;

  /**
   * Once the terminal has been shown, it stays mounted for the rest of the
   * session.
   */
  const [isTerminalMounted, setIsTerminalMounted] = useState(!showOnboarding);
  useEffect(() => {
    if (!showOnboarding) setIsTerminalMounted(true);
  }, [showOnboarding]);

  /**
   * Pairing succeeded: put the terminal on screen and take the pairing UI down.
   * The code has already been consumed at this point — leaving the dialog open
   * would show a form that cannot be submitted again.
   */
  useEffect(() => {
    if (!lastPairedAt) return;
    setIsPairingOpen(false);
    setIsTerminalMounted(true);
    setCurrentView('terminal');
  }, [lastPairedAt]);

  const isTerminalActive = currentView === 'terminal' && !showOnboarding;

  const layerVisibilityStyle = (visible: boolean) =>
    ({
      visibility: visible ? 'visible' : 'hidden',
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? 'auto' : 'none',
      zIndex: visible ? 1 : 0,
    }) as const;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only suppresses the browser menu app-wide; no action of its own
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
      className="flex h-full w-full select-none flex-col overflow-hidden bg-tui-crust font-mono text-tui text-tui-text"
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
          onOpenPairing={() => openPairing(false)}
          onOpenSettings={() => openSettings()}
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
            className={`absolute ${isMobileShell ? 'inset-x-0 top-12 bottom-11' : 'inset-0'} flex flex-col min-h-0 w-full overflow-hidden`}
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
            <KeyToolbar compact={isMobileShell} onCustomize={() => openSettings('agentKeymaps')} />
            <HerdrStartPrompt />
            <HostFontPrompt />
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
              onOpenPairing={() => openPairing(false)}
              showBack={isMobileShell}
            />
          </div>
        )}

        {/* Phone chrome: a reserved top bar plus an overlaid control sheet */}
        {isMobileShell && isTerminalActive && (
          <MobileTerminalShell
            onOpenPairing={() => openPairing(false)}
            onOpenSettings={() => openSettings()}
            onAddProfile={() => openPairing(true)}
          />
        )}
      </div>

      {/* Desktop status area: one TUI line for the live session facts. Mobile
          uses its own compact bottom bar for switching and latency, while the
          remaining controls stay in the sheet. */}
      {!isMobileShell && currentView !== 'admin' && (
        <SessionStatusLine onAddProfile={() => openPairing(true)} />
      )}

      {/* Modals & Floating Overlays */}
      <PairingModal isOpen={isPairingOpen} isAddMode={isPairingAddMode} onClose={closePairing} />
      <SettingsModal
        isOpen={isSettingsOpen}
        initialTab={settingsTab}
        onClose={() => setIsSettingsOpen(false)}
        onOpenAdmin={() => {
          setIsSettingsOpen(false);
          handleNavigate('admin');
        }}
      />
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
