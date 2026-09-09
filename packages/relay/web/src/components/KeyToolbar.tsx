import React, { useState, useCallback, useRef } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { ANSI_KEYS, encodeKeyWithModifiers } from '../protocol/keyEncoder';
import { cn } from '../utils/cn';
import { ToolbarKeyDef, DEFAULT_TOOLBAR_KEYS, getLocalizedKeyTitle } from '../utils/virtualKeys';
import { Gauge } from './tui';

interface KeyToolbarProps {
  /**
   * Phone shell density: shorter keys in a single row that scrolls sideways
   */
  compact?: boolean;
}

/**
 * The touch key bar, drawn as key caps.
 *
 * Every key is a bordered rectangle holding its own name — `ESC`, `^C`, `F7`,
 * `↑` — because that is what a keyboard row looks like in a terminal and because
 * a glyph the user already reads on a physical keycap needs no icon. A latched
 * modifier is inverse-video, the way a TUI shows a held state; nothing else on
 * the bar is filled.
 */

/** One key cap. `h-9` is the smallest comfortable touch target. */
const CAP_BASE =
  'tui-focusable inline-flex shrink-0 select-none items-center justify-center border text-tui font-medium transition-colors';

const CAP_IDLE =
  'border-tui-border bg-tui-surface text-tui-text hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

/** A latched modifier or an open drawer: inverse video, as in a terminal. */
const CAP_ACTIVE = 'border-tui-accent bg-tui-accent text-tui-crust font-bold';

/** Enter is the one key that always commits something, so it leads in accent. */
const CAP_COMMIT =
  'border-tui-ok bg-transparent text-tui-ok hover:bg-tui-ok hover:text-tui-crust font-bold';

export const KeyToolbar: React.FC<KeyToolbarProps> = ({ compact = false }) => {
  const {
    sendKey,
    settings,
    updateSettings,
    isController,
    warnViewerMode,
    t,
    uploadProgress,
    uploadImage,
  } = useTerminal();

  // One key metric everywhere: 36px is the smallest comfortable touch target,
  // and a uniform height is what stops the row reading as a jumble.
  const keyClass = 'h-9 min-w-[2.25rem] px-2';
  const squareKeyClass = 'h-9 w-9';
  const drawerToggleClass = 'h-9 px-2';

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const vibrate = useCallback(() => {
    if (settings.vibrateOnKeyPress && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch {
        // Ignore vibration errors
      }
    }
  }, [settings.vibrateOnKeyPress]);
  const handleImageClick = useCallback(() => {
    vibrate();
    if (!isController) {
      warnViewerMode();
      return;
    }
    if (uploadProgress.active) {
      return;
    }
    fileInputRef.current?.click();
  }, [vibrate, isController, warnViewerMode, uploadProgress.active]);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      const file = files && files[0];
      e.target.value = '';
      if (!file) return;
      uploadImage(file);
    },
    [uploadImage]
  );

  const renderFileInputs = () => (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/*"
        className="hidden"
        data-testid="key-toolbar-file-input"
        onChange={handleFileInputChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/*"
        capture="environment"
        className="hidden"
        data-testid="key-toolbar-camera-input"
        onChange={handleFileInputChange}
      />
    </>
  );

  const renderProgressBar = (collapsed = false) => {
    if (!uploadProgress.active) return null;
    return (
      <div
        data-testid={collapsed ? 'key-toolbar-progress-collapsed' : 'key-toolbar-progress'}
        className="w-full border-b border-tui-border-dim bg-tui-crust px-2 py-1"
      >
        <Gauge
          ratio={uploadProgress.ratio}
          label={uploadProgress.statusText}
          tone={
            uploadProgress.phase === 'completed'
              ? 'ok'
              : uploadProgress.phase === 'error'
              ? 'bad'
              : 'accent'
          }
          aria-label={uploadProgress.statusText}
        />
      </div>
    );
  };

  const renderImageButton = () => {
    const isUploading = uploadProgress.active;
    return (
      <button
        type="button"
        data-testid="image-upload-btn"
        onClick={handleImageClick}
        disabled={isUploading}
        className={cn(
          CAP_BASE,
          keyClass,
          isUploading
            ? 'border-tui-border-dim bg-tui-surface opacity-60 cursor-not-allowed'
            : CAP_IDLE
        )}
        title={isUploading ? uploadProgress.statusText : t('virtualKeyboard.uploadImageTitle')}
        aria-label={t('virtualKeyboard.uploadImage')}
      >
        <span className="font-medium">
          {isUploading ? `${uploadProgress.percent}%` : t('virtualKeyboard.image')}
        </span>
      </button>
    );
  };

  // Modifier latch states
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [shiftLatched, setShiftLatched] = useState(false);

  // Expandable drawers
  const [showFnKeys, setShowFnKeys] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showQuickChords, setShowQuickChords] = useState(false);

  const handleKeyPress = useCallback(
    (keySeq: string, isPlainChar = false) => {
      vibrate();

      if (!isController) {
        warnViewerMode();
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
      warnViewerMode,
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
        className="z-20 flex shrink-0 flex-col border-t border-tui-border bg-tui-mantle pb-[max(env(safe-area-inset-bottom,0px),0.125rem)]"
      >
        {renderFileInputs()}
        {renderProgressBar(true)}
        <div className="flex items-center justify-center px-2 py-0.5">
          <button
            type="button"
            onClick={() => updateSettings({ toolbarVisible: true })}
            className="tui-focusable flex h-6 w-28 items-center justify-center gap-1 text-tui uppercase text-tui-faint transition-colors hover:text-tui-accent"
            title={t('virtualKeyboard.expandToolbar')}
            aria-label={t('virtualKeyboard.expandToolbar')}
            aria-expanded={false}
          >
            <span aria-hidden="true">▴</span>
            <span aria-hidden="true">{t('common.keyBar')}</span>
          </button>
        </div>
      </div>
    );
  }

  // Get configured keys or defaults, filter only enabled keys
  const configuredKeys: ToolbarKeyDef[] =
    settings.virtualKeys && settings.virtualKeys.length > 0
      ? settings.virtualKeys.filter((k) => k.enabled)
      : DEFAULT_TOOLBAR_KEYS;

  /**
   * What a cap says.
   *
   * The arrow and Enter keys are drawn with the same glyphs a terminal prints
   * for them, so the bar reads as a keyboard and not as a toolbar of pictures.
   */
  const renderKeyIconOrLabel = (keyDef: ToolbarKeyDef) => {
    if (keyDef.id === 'left') return <span aria-hidden="true">←</span>;
    if (keyDef.id === 'up') return <span aria-hidden="true">↑</span>;
    if (keyDef.id === 'down') return <span aria-hidden="true">↓</span>;
    if (keyDef.id === 'right') return <span aria-hidden="true">→</span>;
    if (keyDef.id === 'enter') {
      return (
        <span className="flex items-center gap-1">
          <span aria-hidden="true">⏎</span>
          <span className="hidden sm:inline">{t('virtualKeyboard.keyEnter')}</span>
        </span>
      );
    }
    if (keyDef.id === 'drawer_chords') {
      return <span>^C</span>;
    }
    if (keyDef.id === 'drawer_fn') {
      // The drawer opens *above* this row, so the arrow points at where the
      // keys will appear: up to open, down to put them away. It used to point
      // right, at nothing, which is the one direction the drawer never uses.
      return (
        <span className="flex items-center gap-0.5">
          <span>Fn</span>
          <span aria-hidden="true">{showFnKeys ? '▾' : '▴'}</span>
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

  /**
   * A chord in the quick drawer: the sequence, then what it does to the job.
   * `SIGINT` next to `^C` is the terminal's own vocabulary, not a tooltip.
   */
  const chord = (
    code: string,
    caption: string,
    title: string,
    badge: string,
    tone: 'default' | 'bad' | 'warn' = 'default'
  ) => (
    <button
      type="button"
      onClick={() => handleKeyPress(code)}
      className={cn(
        CAP_BASE,
        'h-8 gap-1.5 px-2',
        tone === 'bad'
          ? 'border-tui-bad text-tui-bad hover:bg-tui-bad hover:text-tui-crust'
          : tone === 'warn'
            ? 'border-tui-warn text-tui-warn hover:bg-tui-warn hover:text-tui-crust'
            : CAP_IDLE
      )}
      title={title}
    >
      <span className="font-bold">{caption}</span>
      <span className="text-tui-sm opacity-70">{badge}</span>
    </button>
  );

  return (
    <div
      data-testid="key-toolbar"
      className={cn(
        'z-20 flex shrink-0 select-none flex-col border-t border-tui-border bg-tui-mantle',
        compact
          ? 'pb-[max(env(safe-area-inset-bottom,0px),0.125rem)]'
          : 'pb-[max(env(safe-area-inset-bottom,0px),0.25rem)]'
      )}
      role="toolbar"
      aria-label={t('virtualKeyboard.touchKeyboardShortcuts')}
    >
      {renderFileInputs()}
      {renderProgressBar(false)}
      {/* Function keys */}
      {showFnKeys && (
        <div className="grid grid-cols-6 gap-1 border-b border-tui-border-dim bg-tui-crust p-1.5 sm:grid-cols-12">
          {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const).map((n) => {
            const fKey = `F${n}` as keyof typeof ANSI_KEYS;
            return (
              <button
                key={fKey}
                type="button"
                onClick={() => handleKeyPress(ANSI_KEYS[fKey])}
                className={cn(CAP_BASE, CAP_IDLE, 'h-8')}
              >
                F{n}
              </button>
            );
          })}
        </div>
      )}

      {/* Control chords */}
      {showQuickChords && (
        <div className="scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-tui-border-dim bg-tui-crust p-1.5">
          {chord(ANSI_KEYS.CTRL_C, '^C', t('virtualKeyboard.ctrlCTitle'), t('virtualKeyboard.badgeSigint'), 'bad')}
          {chord(ANSI_KEYS.CTRL_D, '^D', t('virtualKeyboard.ctrlDTitle'), t('virtualKeyboard.badgeEof'))}
          {chord(ANSI_KEYS.CTRL_Z, '^Z', t('virtualKeyboard.ctrlZTitle'), t('virtualKeyboard.badgeTstp'), 'warn')}
          {chord(ANSI_KEYS.CTRL_L, '^L', t('virtualKeyboard.ctrlLTitle'), t('virtualKeyboard.badgeClear'))}
          {chord(ANSI_KEYS.CTRL_R, '^R', t('virtualKeyboard.ctrlRTitle'), t('virtualKeyboard.badgeSearch'))}
          {chord(ANSI_KEYS.CTRL_A, '^A', t('virtualKeyboard.ctrlATitle'), t('virtualKeyboard.badgeStart'))}
          {chord(ANSI_KEYS.CTRL_E, '^E', t('virtualKeyboard.ctrlETitle'), t('virtualKeyboard.badgeEnd'))}
          {chord(ANSI_KEYS.CTRL_K, '^K', t('virtualKeyboard.ctrlKTitle'), t('virtualKeyboard.badgeKill'))}
        </div>
      )}

      {/* Symbols a phone keyboard buries three layers deep */}
      {showSymbols && (
        <div className="scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-tui-border-dim bg-tui-crust p-1.5">
          {['|', '~', '/', '\\', '-', '_', '$', '&', ';', ':', '`', '"', "'", '>', '<', '=', '#', '@', '{', '}', '[', ']'].map(
            (sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => handleKeyPress(sym, true)}
                className={cn(CAP_BASE, CAP_IDLE, 'h-8 w-8 font-bold')}
              >
                {sym}
              </button>
            )
          )}
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
          'flex flex-wrap items-center justify-center gap-1',
          compact ? 'px-1.5 py-1' : 'px-2 py-1.5'
        )}
      >
        {/* The way out sits at the *left* end of the row. Enter is the key that
            commits a command and belongs under the thumb at the right edge, as
            it does on every physical keyboard; a collapse control parked there
            would push it inwards and take the row's most reachable spot for
            something nobody presses mid-session. */}
        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: false })}
          className={cn(
            CAP_BASE,
            squareKeyClass,
            'mr-1 border-tui-border-dim bg-transparent text-tui-faint hover:border-tui-border hover:text-tui-text'
          )}
          title={t('virtualKeyboard.collapseToolbar')}
          aria-label={t('virtualKeyboard.collapseToolbar')}
          aria-expanded={true}
        >
          <span aria-hidden="true">▾</span>
        </button>

        {configuredKeys.map((keyDef) => {
          const active = isKeyActive(keyDef);
          const isEnter = keyDef.id === 'enter';
          const isSquare = ['left', 'up', 'down', 'right'].includes(keyDef.id);
          const isDrawer = keyDef.type === 'drawer';

          const localizedTitle = getLocalizedKeyTitle(keyDef, t);

          const keyBtn = (
            <button
              key={keyDef.id}
              type="button"
              onClick={() => handleKeyClick(keyDef)}
              className={cn(
                CAP_BASE,
                isSquare ? squareKeyClass : isDrawer ? drawerToggleClass : keyClass,
                isEnter ? CAP_COMMIT : active ? CAP_ACTIVE : CAP_IDLE
              )}
              title={localizedTitle}
              aria-label={localizedTitle}
              aria-pressed={active}
            >
              {renderKeyIconOrLabel(keyDef)}
            </button>
          );

          if (isEnter) {
            return (
              <React.Fragment key="enter-with-image">
                {renderImageButton()}
                {keyBtn}
              </React.Fragment>
            );
          }

          return keyBtn;
        })}
        {!configuredKeys.some((k) => k.id === 'enter') && renderImageButton()}
      </div>
    </div>
  );
};
