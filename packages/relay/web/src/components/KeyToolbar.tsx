import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { ANSI_KEYS, encodeKeyWithModifiers } from '../protocol/keyEncoder';
import { formatComboCaption, parseKeyCombo } from '../protocol/keyCombo';
import { cn } from '../utils/cn';
import { ToolbarKeyDef, DEFAULT_TOOLBAR_KEYS, getLocalizedKeyTitle } from '../utils/virtualKeys';
import { AGENT_PROFILES, getDrawerGroups, type AppliedAgentAction } from '../utils/agentKeymaps';
import { Gauge } from './tui';

interface KeyToolbarProps {
  /**
   * Phone shell density: shorter keys in a single row that scrolls sideways
   */
  compact?: boolean;
  /** Opens settings on the agent keys tab, where the user picks what the bar shows. */
  onCustomize?: () => void;
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

/** One key cap. Its height comes from `capHeight`, shared by the whole bar. */
const CAP_BASE =
  'tui-focusable inline-flex shrink-0 select-none items-center justify-center border text-tui font-medium transition-colors';

const CAP_IDLE =
  'border-tui-border bg-tui-surface text-tui-text hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

/** A latched modifier or an open drawer: inverse video, as in a terminal. */
const CAP_ACTIVE = 'border-tui-accent bg-tui-accent text-tui-crust font-bold';

/** Enter is the one key that always commits something, so it leads in accent. */
const CAP_COMMIT =
  'border-tui-ok bg-transparent text-tui-ok hover:bg-tui-ok hover:text-tui-crust font-bold';

const CHORD_TONE_CLASS = {
  default: CAP_IDLE,
  bad: 'border-tui-bad text-tui-bad hover:bg-tui-bad hover:text-tui-crust',
  warn: 'border-tui-warn text-tui-warn hover:bg-tui-warn hover:text-tui-crust',
} as const;

export const KeyToolbar: React.FC<KeyToolbarProps> = ({ compact = false, onCustomize }) => {
  const {
    sendKey,
    settings,
    updateSettings,
    isController,
    warnViewerMode,
    t,
    uploadProgress,
    uploadImage,
    modifierLatch,
    toggleModifierLatch,
    consumeModifierLatch,
    agentProfile,
  } = useTerminal();

  // One cap height for every key on the bar and in its drawers: agent
  // shortcuts a size smaller than ESC beside them made the row read as two
  // toolbars. A finger gets a little more height than a pointer does.
  const capHeight = compact ? 'h-8' : 'h-7';
  const keyClass = compact ? 'h-8 min-w-[2rem] px-1.5' : 'h-7 min-w-[1.75rem] px-1.5';
  const squareKeyClass = compact ? 'h-8 w-8' : 'h-7 w-7';
  const drawerToggleClass = compact ? 'h-8 px-1.5' : 'h-7 px-1.5';

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
    [uploadImage],
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
            : CAP_IDLE,
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

  // Expandable drawers
  const [showFnKeys, setShowFnKeys] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showQuickChords, setShowQuickChords] = useState(false);
  const comboTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      comboTimersRef.current.forEach((timer) => clearTimeout(timer));
      comboTimersRef.current = [];
    },
    [],
  );

  // Whether the sideways strip hides keys past its right edge, which is when it
  // fades out there to say so.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [moreToRight, setMoreToRight] = useState(false);
  const measureScroll = useCallback(() => {
    const strip = scrollRef.current;
    setMoreToRight(
      Boolean(strip) && strip!.scrollLeft + strip!.clientWidth < strip!.scrollWidth - 1,
    );
  }, []);
  // Keys can come and go without the strip changing size (a profile switch, a
  // key added in settings), so every render re-measures; an unchanged answer
  // does not render again.
  useEffect(measureScroll);
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measureScroll);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measureScroll, settings.toolbarVisible]);

  const sendAgentCombo = useCallback(
    (combo: string) => {
      vibrate();
      if (!isController) {
        warnViewerMode();
        return;
      }

      let steps: string[];
      try {
        steps = parseKeyCombo(combo);
      } catch {
        return;
      }
      // A ready-made shortcut consumes a pending modifier the same way a Ctrl
      // chord does; its own declared modifiers are already part of the combo.
      consumeModifierLatch();
      if (steps.length === 1) {
        sendKey(steps[0]);
        return;
      }

      // The adapter merges writes queued in one microtask. Spacing sequence steps
      // keeps Esc Esc as two keypresses so rewind menus still receive both.
      steps.forEach((step, index) => {
        const timer = setTimeout(() => {
          comboTimersRef.current = comboTimersRef.current.filter((item) => item !== timer);
          sendKey(step);
        }, index * 120);
        comboTimersRef.current.push(timer);
      });
    },
    [consumeModifierLatch, isController, sendKey, vibrate, warnViewerMode],
  );

  const agentGroups = getDrawerGroups(agentProfile, settings.agentKeymaps[agentProfile]);

  const renderAgentAction = (item: AppliedAgentAction) => {
    let caption = '';
    try {
      caption = formatComboCaption(item.combo);
    } catch {}
    const label = item.custom ? item.customLabel || '' : t(`agentActions.${item.labelKey}`);
    const tone =
      item.labelKey === 'interrupt' && item.combo.trim().toLowerCase() === 'ctrl+c'
        ? 'bad'
        : item.combo.trim().toLowerCase() === 'ctrl+z'
          ? 'warn'
          : 'default';
    return (
      <button
        key={item.id}
        type="button"
        data-testid={`agent-key-${item.id}`}
        onClick={() => sendAgentCombo(item.combo)}
        className={cn(CAP_BASE, capHeight, 'max-w-[10rem] gap-1 px-1.5', CHORD_TONE_CLASS[tone])}
        title={`${caption} ${label}`.trim()}
        aria-label={`${caption} ${label}`.trim()}
      >
        <span className="font-bold">{caption}</span>
        <span className="max-w-[5rem] truncate text-tui-sm opacity-70">{label}</span>
      </button>
    );
  };
  const renderInlineAgentActions = () => {
    const actions = [...agentGroups.agentActions, ...agentGroups.genericActions];
    // Kept even with every shortcut hidden, so there is always a way back to them.
    if (actions.length === 0 && !onCustomize) return null;
    return (
      <div
        data-testid="agent-key-actions"
        role="group"
        aria-label={`${AGENT_PROFILES[agentProfile].name} ${t('agentKeymaps.agentGroup')}`}
        className="flex shrink-0 items-center gap-1"
      >
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-tui-border-dim" />
        {actions.map(renderAgentAction)}
        {onCustomize && (
          <button
            type="button"
            data-testid="agent-key-customize"
            onClick={onCustomize}
            className={cn(
              CAP_BASE,
              capHeight,
              'px-1.5 text-tui-sm border-tui-border-dim bg-transparent text-tui-faint hover:border-tui-accent hover:text-tui-accent',
            )}
            title={t('agentKeymaps.customizeBar')}
            aria-label={t('agentKeymaps.customizeBar')}
          >
            {t('agentKeymaps.customizeBarShort')}
          </button>
        )}
      </div>
    );
  };

  /**
   * Sends one key, with whatever modifiers are latched. A latch applies to the
   * next key of any kind — Ctrl+←, Shift+Enter, Shift+F5 — and a ready-made
   * chord such as ^C just releases it, since the chord already says what it is.
   */
  const handleKeyPress = useCallback(
    (keySeq: string, modifiable = true) => {
      vibrate();

      if (!isController) {
        warnViewerMode();
        return;
      }

      const modifiers = consumeModifierLatch();
      sendKey(modifiable && modifiers ? encodeKeyWithModifiers(keySeq, modifiers) : keySeq);
    },
    [isController, sendKey, warnViewerMode, vibrate, consumeModifierLatch],
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
      if (
        keyDef.modifierType === 'ctrl' ||
        keyDef.modifierType === 'alt' ||
        keyDef.modifierType === 'shift'
      ) {
        toggleModifierLatch(keyDef.modifierType);
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
    handleKeyPress(keyDef.code, keyDef.type !== 'chord');
  };

  const isKeyActive = (keyDef: ToolbarKeyDef) => {
    if (keyDef.type === 'modifier') {
      if (keyDef.modifierType === 'ctrl') return modifierLatch.ctrl;
      if (keyDef.modifierType === 'alt') return modifierLatch.alt;
      if (keyDef.modifierType === 'shift') return modifierLatch.shift;
    }
    if (keyDef.type === 'drawer') {
      if (keyDef.drawerType === 'fn') return showFnKeys;
      if (keyDef.drawerType === 'chords') return showQuickChords;
      if (keyDef.drawerType === 'symbols') return showSymbols;
    }
    return false;
  };

  const renderKey = (keyDef: ToolbarKeyDef) => {
    const active = isKeyActive(keyDef);
    const isSquare = ['left', 'up', 'down', 'right'].includes(keyDef.id);
    const isDrawer = keyDef.type === 'drawer';
    const accessibleTitle = getLocalizedKeyTitle(keyDef, t);

    return (
      <button
        key={keyDef.id}
        type="button"
        onClick={() => handleKeyClick(keyDef)}
        className={cn(
          CAP_BASE,
          isSquare ? squareKeyClass : isDrawer ? drawerToggleClass : keyClass,
          keyDef.id === 'enter' ? CAP_COMMIT : active ? CAP_ACTIVE : CAP_IDLE,
        )}
        title={accessibleTitle}
        aria-label={accessibleTitle}
        aria-pressed={active}
      >
        {renderKeyIconOrLabel(keyDef)}
      </button>
    );
  };

  const enterKey = configuredKeys.find((keyDef) => keyDef.id === 'enter');

  /**
   * A chord in the quick drawer: the sequence, then what it does to the job.
   * `SIGINT` next to `^C` is the terminal's own vocabulary, not a tooltip.
   */
  const chord = (
    code: string,
    caption: string,
    title: string,
    badge: string,
    tone: 'default' | 'bad' | 'warn' = 'default',
  ) => (
    <button
      type="button"
      onClick={() => handleKeyPress(code, false)}
      className={cn(CAP_BASE, capHeight, 'gap-1.5 px-2', CHORD_TONE_CLASS[tone])}
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
          : 'pb-[max(env(safe-area-inset-bottom,0px),0.25rem)]',
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
                className={cn(CAP_BASE, CAP_IDLE, capHeight)}
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
          {chord(
            ANSI_KEYS.CTRL_C,
            '^C',
            t('virtualKeyboard.ctrlCTitle'),
            t('virtualKeyboard.badgeSigint'),
            'bad',
          )}
          {chord(
            ANSI_KEYS.CTRL_D,
            '^D',
            t('virtualKeyboard.ctrlDTitle'),
            t('virtualKeyboard.badgeEof'),
          )}
          {chord(
            ANSI_KEYS.CTRL_Z,
            '^Z',
            t('virtualKeyboard.ctrlZTitle'),
            t('virtualKeyboard.badgeTstp'),
            'warn',
          )}
          {chord(
            ANSI_KEYS.CTRL_L,
            '^L',
            t('virtualKeyboard.ctrlLTitle'),
            t('virtualKeyboard.badgeClear'),
          )}
          {chord(
            ANSI_KEYS.CTRL_R,
            '^R',
            t('virtualKeyboard.ctrlRTitle'),
            t('virtualKeyboard.badgeSearch'),
          )}
          {chord(
            ANSI_KEYS.CTRL_A,
            '^A',
            t('virtualKeyboard.ctrlATitle'),
            t('virtualKeyboard.badgeStart'),
          )}
          {chord(
            ANSI_KEYS.CTRL_E,
            '^E',
            t('virtualKeyboard.ctrlETitle'),
            t('virtualKeyboard.badgeEnd'),
          )}
          {chord(
            ANSI_KEYS.CTRL_K,
            '^K',
            t('virtualKeyboard.ctrlKTitle'),
            t('virtualKeyboard.badgeKill'),
          )}
        </div>
      )}

      {/* Symbols a phone keyboard buries three layers deep */}
      {showSymbols && (
        <div className="scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-tui-border-dim bg-tui-crust p-1.5">
          {[
            '|',
            '~',
            '/',
            '\\',
            '-',
            '_',
            '$',
            '&',
            ';',
            ':',
            '`',
            '"',
            "'",
            '>',
            '<',
            '=',
            '#',
            '@',
            '{',
            '}',
            '[',
            ']',
          ].map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => handleKeyPress(sym, true)}
              className={cn(CAP_BASE, CAP_IDLE, squareKeyClass, 'font-bold')}
            >
              {sym}
            </button>
          ))}
        </div>
      )}

      {/* Everything but Enter shares one strip that scrolls sideways when it
          runs out of room. Enter stays outside it, pinned under the thumb: a
          phone's bar is always wider than its screen, and the key that commits
          a command must never be the one scrolled out of reach. The strip only
          takes the width its keys need, so a desktop wide enough for all of
          them keeps Enter right after the last key instead of across a gap. */}
      <div
        data-testid="key-toolbar-row"
        className={cn(
          'flex flex-nowrap items-center justify-start gap-1',
          compact ? 'px-1.5 py-1' : 'px-2 py-1.5',
        )}
      >
        <div className="relative min-w-0">
          <div
            ref={scrollRef}
            data-testid="key-toolbar-scroll"
            onScroll={measureScroll}
            className="scrollbar-none flex flex-nowrap touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain"
          >
            {/* The way out sits at the *left* end of the row, away from Enter
                at the right: a collapse control is something nobody presses
                mid-session and has no claim on the most reachable spot. */}
            <button
              type="button"
              onClick={() => updateSettings({ toolbarVisible: false })}
              className={cn(
                CAP_BASE,
                squareKeyClass,
                'mr-1 border-tui-border-dim bg-transparent text-tui-faint hover:border-tui-border hover:text-tui-text',
              )}
              title={t('virtualKeyboard.collapseToolbar')}
              aria-label={t('virtualKeyboard.collapseToolbar')}
              aria-expanded={true}
            >
              <span aria-hidden="true">▾</span>
            </button>

            {configuredKeys.filter((keyDef) => keyDef.id !== 'enter').map(renderKey)}
            {renderInlineAgentActions()}
            {renderImageButton()}
          </div>
          {moreToRight && (
            <span
              aria-hidden="true"
              data-testid="key-toolbar-more"
              className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-tui-mantle"
            />
          )}
        </div>
        {enterKey && renderKey(enterKey)}
      </div>
    </div>
  );
};
