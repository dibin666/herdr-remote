import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings, useTerminalIO } from '../context/TerminalContext';
import { ANSI_KEYS } from '../protocol/keyEncoder';
import { cn } from '../utils/cn';
import {
  DEFAULT_TOOLBAR_KEYS,
  getLocalizedKeyTitle,
  type ToolbarKeyDef,
} from '../utils/virtualKeys';
import { AgentKeyActions } from './keyToolbar/AgentKeyActions';
import { CAP_ACTIVE, CAP_BASE, CAP_COMMIT, CAP_IDLE, capSizes } from './keyToolbar/caps';
import { ChordsDrawer, FnKeysDrawer, SymbolsDrawer } from './keyToolbar/KeyDrawers';
import {
  ImageUploadButton,
  UploadFileInputs,
  UploadProgressBar,
} from './keyToolbar/UploadControls';
import { useKeySender } from './keyToolbar/useKeySender';

interface KeyToolbarProps {
  /**
   * Phone shell density: shorter keys in a single row that scrolls sideways
   */
  compact?: boolean;
  /** Opens settings on the agent keys tab, where the user picks what the bar shows. */
  onCustomize?: () => void;
}

/** The touch key bar; see `keyToolbar/caps.ts` for how its keys are drawn. */
export const KeyToolbar: React.FC<KeyToolbarProps> = ({ compact = false, onCustomize }) => {
  const { settings, updateSettings, t } = useSettings();
  const { modifierLatch, toggleModifierLatch } = useTerminalIO();
  const { vibrate, pressKey: handleKeyPress, sendCombo } = useKeySender();
  const { capHeight, keyClass, squareKeyClass, drawerToggleClass } = capSizes(compact);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Expandable drawers
  const [showFnKeys, setShowFnKeys] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showQuickChords, setShowQuickChords] = useState(false);

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

  // Collapsed, the bar leaves a handle behind rather than vanishing: a key bar
  // with no way back is a setting the user has to go hunting for.
  if (!settings.toolbarVisible) {
    return (
      <div
        data-testid="key-toolbar-collapsed"
        className="z-20 flex shrink-0 flex-col border-t border-tui-border bg-tui-mantle pb-[max(env(safe-area-inset-bottom,0px),0.125rem)]"
      >
        <UploadFileInputs fileInputRef={fileInputRef} />
        <UploadProgressBar collapsed />
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
      <UploadFileInputs fileInputRef={fileInputRef} />
      <UploadProgressBar collapsed={false} />
      {showFnKeys && <FnKeysDrawer capHeight={capHeight} onKey={handleKeyPress} />}
      {showQuickChords && <ChordsDrawer capHeight={capHeight} onKey={handleKeyPress} />}
      {showSymbols && <SymbolsDrawer squareKeyClass={squareKeyClass} onKey={handleKeyPress} />}

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
            <AgentKeyActions
              capHeight={capHeight}
              onCustomize={onCustomize}
              sendCombo={sendCombo}
            />
            <ImageUploadButton fileInputRef={fileInputRef} keyClass={keyClass} vibrate={vibrate} />
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
