import React, { useState, useCallback } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { ANSI_KEYS, encodeKeyWithModifiers } from '../protocol/keyEncoder';
import {
  ChevronUp,
  ChevronDown,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Command,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { ToolbarKeyDef, DEFAULT_TOOLBAR_KEYS, getLocalizedKeyTitle } from '../utils/virtualKeys';

interface KeyToolbarProps {
  /**
   * Phone shell density: shorter keys in a single row that scrolls sideways
   */
  compact?: boolean;
}

export const KeyToolbar: React.FC<KeyToolbarProps> = ({ compact = false }) => {
  const { sendKey, settings, updateSettings, isController, addToast, t } = useTerminal();

  // One key metric everywhere: 36px is the smallest comfortable touch target,
  // and a uniform height is what stops the row reading as a jumble.
  const keyClass = 'h-9 min-w-[2.25rem] px-2.5 text-xs';
  const squareKeyClass = 'w-9 h-9 text-xs';
  const drawerToggleClass = 'h-9 px-2.5 text-xs';

  // Modifier latch states
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [shiftLatched, setShiftLatched] = useState(false);

  // Expandable drawers
  const [showFnKeys, setShowFnKeys] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showQuickChords, setShowQuickChords] = useState(false);

  const vibrate = useCallback(() => {
    if (settings.vibrateOnKeyPress && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch {
        // Ignore vibration errors
      }
    }
  }, [settings.vibrateOnKeyPress]);

  const handleKeyPress = useCallback(
    (keySeq: string, isPlainChar = false) => {
      vibrate();

      if (!isController) {
        addToast('warning', t('toasts.viewerModeWarning'));
        return;
      }

      let toSend = keySeq;

      if (isPlainChar && (ctrlLatched || altLatched || shiftLatched)) {
        toSend = encodeKeyWithModifiers(keySeq, {
          ctrl: ctrlLatched,
          alt: altLatched,
          shift: shiftLatched,
        });
      }

      sendKey(toSend);

      // Auto un-latch modifiers after use
      if (ctrlLatched) setCtrlLatched(false);
      if (altLatched) setAltLatched(false);
      if (shiftLatched) setShiftLatched(false);
    },
    [
      isController,
      ctrlLatched,
      altLatched,
      shiftLatched,
      sendKey,
      addToast,
      vibrate,
      t,
    ]
  );

  // Collapsed, the bar leaves a handle behind rather than vanishing: a key bar
  // with no way back is a setting the user has to go hunting for.
  if (!settings.toolbarVisible) {
    return (
      <div
        data-testid="key-toolbar-collapsed"
        className="shrink-0 z-20 flex justify-center border-t border-sand-400/70 dark:border-charcoal-700 bg-sand-200/95 dark:bg-charcoal-900/95 backdrop-blur-md pb-[max(env(safe-area-inset-bottom,0px),0.125rem)]"
      >
        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: true })}
          className="flex h-6 w-24 items-center justify-center text-charcoal-500 transition-colors hover:text-charcoal-800 dark:text-charcoal-400 dark:hover:text-charcoal-100"
          title={t('virtualKeyboard.expandToolbar')}
          aria-label={t('virtualKeyboard.expandToolbar')}
          aria-expanded={false}
        >
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  // Get configured keys or defaults, filter only enabled keys
  const configuredKeys: ToolbarKeyDef[] =
    settings.virtualKeys && settings.virtualKeys.length > 0
      ? settings.virtualKeys.filter((k) => k.enabled)
      : DEFAULT_TOOLBAR_KEYS;

  const renderKeyIconOrLabel = (keyDef: ToolbarKeyDef) => {
    if (keyDef.id === 'left') return <ArrowLeft className="w-4 h-4" />;
    if (keyDef.id === 'up') return <ArrowUp className="w-4 h-4" />;
    if (keyDef.id === 'down') return <ArrowDown className="w-4 h-4" />;
    if (keyDef.id === 'right') return <ArrowRight className="w-4 h-4" />;
    if (keyDef.id === 'enter') {
      return (
        <span className="flex items-center gap-1">
          <CornerDownLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('virtualKeyboard.keyEnter')}</span>
        </span>
      );
    }
    if (keyDef.id === 'drawer_chords') {
      return (
        <span className="flex items-center gap-1 font-mono">
          <Command className="w-3.5 h-3.5" />
          <span>^C</span>
        </span>
      );
    }
    if (keyDef.id === 'drawer_fn') {
      return (
        <span className="flex items-center gap-0.5 font-mono">
          <span>Fn</span>
          {showFnKeys ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </span>
      );
    }
    return <span>{keyDef.label}</span>;
  };

  const handleKeyClick = (keyDef: ToolbarKeyDef) => {
    vibrate();

    // Modifier toggles
    if (keyDef.type === 'modifier') {
      if (keyDef.modifierType === 'ctrl') {
        setCtrlLatched(!ctrlLatched);
      } else if (keyDef.modifierType === 'alt') {
        setAltLatched(!altLatched);
      } else if (keyDef.modifierType === 'shift') {
        setShiftLatched(!shiftLatched);
      } else if (keyDef.modifierType === 'meta') {
        handleKeyPress(ANSI_KEYS.ESC);
      }
      return;
    }

    // Drawer toggles
    if (keyDef.type === 'drawer') {
      if (keyDef.drawerType === 'fn') {
        setShowFnKeys(!showFnKeys);
        setShowSymbols(false);
        setShowQuickChords(false);
      } else if (keyDef.drawerType === 'chords') {
        setShowQuickChords(!showQuickChords);
        setShowFnKeys(false);
        setShowSymbols(false);
      } else if (keyDef.drawerType === 'symbols') {
        setShowSymbols(!showSymbols);
        setShowFnKeys(false);
        setShowQuickChords(false);
      }
      return;
    }

    // Direct key send
    handleKeyPress(keyDef.code, keyDef.isPlainChar || keyDef.type === 'symbol');
  };

  const isKeyActive = (keyDef: ToolbarKeyDef) => {
    if (keyDef.type === 'modifier') {
      if (keyDef.modifierType === 'ctrl') return ctrlLatched;
      if (keyDef.modifierType === 'alt') return altLatched;
      if (keyDef.modifierType === 'shift') return shiftLatched;
    }
    if (keyDef.type === 'drawer') {
      if (keyDef.drawerType === 'fn') return showFnKeys;
      if (keyDef.drawerType === 'chords') return showQuickChords;
      if (keyDef.drawerType === 'symbols') return showSymbols;
    }
    return false;
  };

  return (
    <div
      data-testid="key-toolbar"
      className={cn(
        'bg-sand-200/95 dark:bg-charcoal-900/95 backdrop-blur-md border-t border-sand-400/70 dark:border-charcoal-700 select-none z-20 flex flex-col transition-all shrink-0',
        compact
          ? 'pb-[max(env(safe-area-inset-bottom,0px),0.125rem)]'
          : 'pb-[max(env(safe-area-inset-bottom,0px),0.25rem)]'
      )}
      role="toolbar"
      aria-label={t('virtualKeyboard.touchKeyboardShortcuts')}
    >
      {/* Expandable Fn Keys Drawer */}
      {showFnKeys && (
        <div className="grid grid-cols-6 sm:grid-cols-12 gap-1 p-1.5 bg-sand-100/90 dark:bg-charcoal-950/80 border-b border-sand-300 dark:border-charcoal-800 text-xs animate-in slide-in-from-top-1">
          {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const).map((n) => {
            const fKey = `F${n}` as keyof typeof ANSI_KEYS;
            return (
              <button
                key={fKey}
                type="button"
                onClick={() => handleKeyPress(ANSI_KEYS[fKey])}
                className="h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 active:bg-herdr-900 active:text-white text-charcoal-800 dark:text-charcoal-200 font-mono font-medium border border-sand-300 dark:border-charcoal-700 flex items-center justify-center transition-colors text-xs shadow-sm"
              >
                F{n}
              </button>
            );
          })}
        </div>
      )}

      {/* Expandable Quick Chords Drawer */}
      {showQuickChords && (
        <div className="flex items-center gap-1.5 p-1.5 overflow-x-auto bg-sand-100/90 dark:bg-charcoal-950/80 border-b border-sand-300 dark:border-charcoal-800 text-xs scrollbar-none animate-in slide-in-from-top-1">
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_C)}
            className="px-2.5 h-8 rounded-lg bg-red-50 hover:bg-red-100 dark:bg-red-950/70 dark:hover:bg-red-900 border border-red-300 dark:border-red-700/60 text-red-700 dark:text-red-300 font-mono font-semibold flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlCTitle')}
          >
            <span>^C</span> <span className="text-[10px] text-red-600 dark:text-red-400 opacity-80">{t('virtualKeyboard.badgeSigint')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_D)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlDTitle')}
          >
            <span>^D</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeEof')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_Z)}
            className="px-2.5 h-8 rounded-lg bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/70 dark:hover:bg-amber-900 border border-amber-300 dark:border-amber-700/60 text-amber-800 dark:text-amber-300 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlZTitle')}
          >
            <span>^Z</span> <span className="text-[10px] text-amber-700 dark:text-amber-400 opacity-80">{t('virtualKeyboard.badgeTstp')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_L)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlLTitle')}
          >
            <span>^L</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeClear')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_R)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlRTitle')}
          >
            <span>^R</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeSearch')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_A)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlATitle')}
          >
            <span>^A</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeStart')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_E)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlETitle')}
          >
            <span>^E</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeEnd')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(ANSI_KEYS.CTRL_K)}
            className="px-2.5 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 border border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono font-medium flex items-center gap-1 flex-shrink-0 shadow-sm"
            title={t('virtualKeyboard.ctrlKTitle')}
          >
            <span>^K</span> <span className="text-[10px] text-charcoal-500 opacity-80">{t('virtualKeyboard.badgeKill')}</span>
          </button>
        </div>
      )}

      {/* Expandable Symbols Drawer */}
      {showSymbols && (
        <div className="flex items-center gap-1 p-1.5 overflow-x-auto bg-sand-100/90 dark:bg-charcoal-950/80 border-b border-sand-300 dark:border-charcoal-800 text-xs scrollbar-none animate-in slide-in-from-top-1">
          {['|', '~', '/', '\\', '-', '_', '$', '&', ';', ':', '`', '"', "'", '>', '<', '=', '#', '@', '{', '}', '[', ']'].map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => handleKeyPress(sym, true)}
              className="w-8 h-8 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 active:bg-herdr-900 active:text-white text-charcoal-800 dark:text-charcoal-200 font-mono font-bold border border-sand-300 dark:border-charcoal-700 flex items-center justify-center flex-shrink-0 transition-colors text-sm shadow-sm"
            >
              {sym}
            </button>
          ))}
        </div>
      )}

      {/* Dynamic Key Toolbar Row */}
      {/* The row wraps rather than scrolling sideways. Spreading the keys across
          the full width (`justify-between`) opened chasms between them on a
          desktop, and a single nowrap row pushed the last keys off the right
          edge of a phone where nothing hinted they were there. */}
      <div
        data-testid="key-toolbar-row"
        className={cn(
          'flex flex-wrap items-center justify-center gap-1.5',
          compact ? 'px-1.5 py-1' : 'px-2 py-1.5'
        )}
      >
        {configuredKeys.map((keyDef) => {
          const active = isKeyActive(keyDef);
          const isEnter = keyDef.id === 'enter';
          const isSquare = ['left', 'up', 'down', 'right'].includes(keyDef.id);
          const isDrawer = keyDef.type === 'drawer';

          let buttonStyle = 'bg-sand-100 dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 text-charcoal-800 dark:text-charcoal-200 border-sand-300 dark:border-charcoal-700';

          if (isEnter) {
            buttonStyle = 'bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white font-medium border-herdr-600 shadow-sm';
          } else if (active) {
            buttonStyle = keyDef.type === 'modifier'
              ? 'bg-emerald-600 text-white border-emerald-500 ring-2 ring-emerald-500/40 font-bold'
              : 'bg-herdr-100 dark:bg-herdr-950 border-herdr-400 text-herdr-700 dark:text-herdr-300 font-bold';
          }

          const localizedTitle = getLocalizedKeyTitle(keyDef, t);

          return (
            <button
              key={keyDef.id}
              type="button"
              onClick={() => handleKeyClick(keyDef)}
              className={cn(
                isSquare ? squareKeyClass : isDrawer ? drawerToggleClass : keyClass,
                'rounded-lg font-mono font-medium border shadow-sm flex items-center justify-center transition-all shrink-0',
                buttonStyle
              )}
              title={localizedTitle}
              aria-label={localizedTitle}
              aria-pressed={active}
            >
              {renderKeyIconOrLabel(keyDef)}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: false })}
          className={cn(
            squareKeyClass,
            'ml-1 rounded-lg border border-sand-400/60 dark:border-charcoal-700 bg-sand-100 dark:bg-charcoal-800 text-charcoal-500 dark:text-charcoal-400 hover:text-charcoal-800 dark:hover:text-charcoal-100 flex items-center justify-center transition-colors shrink-0'
          )}
          title={t('virtualKeyboard.collapseToolbar')}
          aria-label={t('virtualKeyboard.collapseToolbar')}
          aria-expanded={true}
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
