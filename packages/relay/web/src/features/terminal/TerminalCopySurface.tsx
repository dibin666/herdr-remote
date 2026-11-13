/** Read-only text controls give a canvas terminal the phone's native copy UI. */
import type { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Translate } from '@/shared/i18n';
import { mirrorRegion, mirrorSelectionText, type MirrorRegion } from './copyMode';
import {
  nativeCopyField,
  nativeCopySelection,
  TERMINAL_TOUCH_DRAG_THRESHOLD_PX,
} from './nativeCopy';
import { paneRegions } from './paneSelection';
import { measureCellDimensions } from './terminalFit';

interface RegionLayout {
  mirror: MirrorRegion;
  top: number;
  left: number;
  width: number;
  height: number;
  key: string;
}

export function TerminalCopySurface({
  term,
  surface,
  container,
  t,
  onSelectionChange,
}: {
  term: Terminal;
  surface: HTMLElement | null;
  container: HTMLElement | null;
  t: Translate;
  onSelectionChange: (active: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const frozenRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const [fontRevision, setFontRevision] = useState(0);
  const [pressedField, setPressedField] = useState<HTMLTextAreaElement | null>(null);
  const [selectedField, setSelectedField] = useState<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const root = rootRef.current;
      if (frozenRef.current || (root && nativeCopySelection(root))) return;
      setRevision((value) => value + 1);
    });
  }, []);

  const readSelection = useCallback(() => {
    const root = rootRef.current;
    const field = root ? nativeCopySelection(root) : null;
    setSelectedField(field);
    frozenRef.current = Boolean(pressRef.current || field);
    onSelectionChange(Boolean(field));
    if (!frozenRef.current) refresh();
  }, [onSelectionChange, refresh]);

  const clearSelection = useCallback(() => {
    pressRef.current = null;
    frozenRef.current = false;
    setPressedField(null);
    setSelectedField(null);
    onSelectionChange(false);
    refresh();
  }, [onSelectionChange, refresh]);

  useEffect(() => {
    const render = term.onRender(refresh);
    // The custom canvas renderer can paint without xterm's public render event.
    const parsed = term.onWriteParsed(refresh);
    const scroll = term.onScroll(refresh);
    const resize = term.onResize(() => {
      const field = nativeCopyField(document.activeElement);
      if (field && rootRef.current?.contains(field)) field.blur();
      pressRef.current = null;
      frozenRef.current = false;
      setPressedField(null);
      readSelection();
      refresh();
    });
    const fonts = document.fonts;
    const onFontsLoaded = () => {
      setFontRevision((value) => value + 1);
      refresh();
    };
    document.addEventListener('selectionchange', readSelection);
    fonts?.addEventListener?.('loadingdone', onFontsLoaded);
    refresh();
    return () => {
      render.dispose();
      parsed.dispose();
      scroll.dispose();
      resize.dispose();
      document.removeEventListener('selectionchange', readSelection);
      fonts?.removeEventListener?.('loadingdone', onFontsLoaded);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      onSelectionChange(false);
    };
  }, [term, onSelectionChange, readSelection, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates the mutable xterm buffer and measured geometry
  const layout = useMemo(() => {
    const screen = (surface?.querySelector('.xterm-screen') as HTMLElement | null) || surface;
    if (!screen || !container) return null;
    const cell = measureCellDimensions(term);
    if (cell.cellWidth <= 0 || cell.cellHeight <= 0) return null;
    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const viewportY = term.buffer.active.viewportY;
    const regions: RegionLayout[] = [];
    for (const region of paneRegions(term)) {
      const row = region.startRow - viewportY;
      regions.push({
        mirror: mirrorRegion(term, region),
        top: screenRect.top - containerRect.top + row * cell.cellHeight,
        left: screenRect.left - containerRect.left + region.startCol * cell.cellWidth,
        width: (region.endCol - region.startCol + 1) * cell.cellWidth,
        height: (region.endRow - region.startRow + 1) * cell.cellHeight,
        // A buffer scroll must not replace the control holding the touch.
        key: `${region.startCol}:${region.endCol}:${row}`,
      });
    }
    return { regions, cellWidth: cell.cellWidth, cellHeight: cell.cellHeight };
  }, [term, surface, container, revision, fontRevision]);

  const family = term.options.fontFamily || 'monospace';
  const baseFontSize = term.options.fontSize || 14;
  const cellWidth = layout?.cellWidth || 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a loaded font can change its advance without changing its family name
  const fontSize = useMemo(() => {
    const probe = document.createElement('span');
    probe.style.cssText = `position:fixed;visibility:hidden;white-space:pre;font-size:${baseFontSize}px;font-family:${family};line-height:1`;
    probe.textContent = '0000000000';
    document.body.appendChild(probe);
    const advance = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return advance > 0 ? (baseFontSize * cellWidth) / advance : baseFontSize;
  }, [baseFontSize, family, cellWidth, fontRevision]);

  const prepare = (field: HTMLTextAreaElement, point: { clientX: number; clientY: number }) => {
    // Focus can blur another copy field; freeze only after that cleanup runs.
    field.focus({ preventScroll: true });
    frozenRef.current = true;
    pressRef.current = { x: point.clientX, y: point.clientY };
    setPressedField(field);
  };
  const release = () => {
    pressRef.current = null;
    setPressedField(null);
    readSelection();
  };
  const move = (point: { clientX: number; clientY: number }) => {
    const press = pressRef.current;
    if (
      press &&
      !selectedField &&
      Math.hypot(point.clientX - press.x, point.clientY - press.y) >
        TERMINAL_TOUCH_DRAG_THRESHOLD_PX
    ) {
      release();
    }
  };
  const usesPointerEvents = typeof window.PointerEvent !== 'undefined';

  if (!layout) return null;
  return (
    <div
      ref={rootRef}
      data-testid="terminal-copy-surface"
      className="pointer-events-none absolute inset-0 z-20"
    >
      {layout.regions.map((region, index) => {
        const active =
          fieldRefs.current[index] === pressedField || fieldRefs.current[index] === selectedField;
        return (
          <textarea
            key={region.key}
            ref={(field) => {
              fieldRefs.current[index] = field;
            }}
            data-testid="terminal-copy-field"
            data-terminal-copy-field=""
            aria-label={t('clipboard.nativeCopyRegion')}
            readOnly
            inputMode="none"
            tabIndex={-1}
            wrap="off"
            spellCheck={false}
            value={region.mirror.rows.map((row) => row.text).join('\n')}
            className="terminal-copy-field pointer-events-auto absolute m-0 resize-none appearance-none overflow-hidden border-0 p-0 outline-none"
            style={{
              top: region.top,
              left: region.left,
              width: region.width,
              height: region.height,
              fontSize,
              lineHeight: `${layout.cellHeight}px`,
              fontFamily: family,
              userSelect: 'text',
              WebkitUserSelect: 'text',
              WebkitTouchCallout: 'default',
              touchAction: 'none',
              caretColor: 'transparent',
              color: active ? term.options.theme?.foreground || 'var(--tui-text)' : 'transparent',
              backgroundColor: active
                ? term.options.theme?.background || 'var(--tui-crust)'
                : 'transparent',
            }}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse') return;
              if (event.isPrimary) prepare(event.currentTarget, event);
              else release();
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== 'mouse') move(event);
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onTouchStart={(event) => {
              if (!usesPointerEvents && event.touches.length === 1)
                prepare(event.currentTarget, event.touches[0]);
            }}
            onTouchMove={(event) => {
              if (!usesPointerEvents && event.touches.length === 1) move(event.touches[0]);
            }}
            onTouchEnd={() => {
              if (!usesPointerEvents) release();
            }}
            onTouchCancel={() => {
              if (!usesPointerEvents) release();
            }}
            onSelect={readSelection}
            onFocus={readSelection}
            onBlur={clearSelection}
            onCopy={(event) => {
              const field = event.currentTarget;
              if (!event.clipboardData || field.selectionStart === field.selectionEnd) return;
              event.clipboardData.setData(
                'text/plain',
                mirrorSelectionText(region.mirror, field.selectionStart, field.selectionEnd),
              );
              event.preventDefault();
            }}
            onPasteCapture={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        );
      })}
    </div>
  );
}
