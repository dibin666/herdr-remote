import React from 'react';
import { cn } from '@/shared/lib/cn';
import { Sep } from './tokens';
import { type KeyHint, KeyHints, type TabDescriptor, Tabs } from './buttons';

/* ---------------------------------------------------------------- segments */

/**
 * Values joined by `·`, the separator Herdr uses between tokens on one row.
 *
 * A status area is a single line of text, not a row of chips: falsy entries and
 * the separator that would have preceded them disappear, exactly as an unset
 * sidebar token does in Herdr.
 */
export const Segments: React.FC<{
  items: React.ReactNode[];
  className?: string;
}> = ({ items, className }) => {
  const visible = items.filter(Boolean);
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {visible.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the items are an ordered list of nodes with no identity of their own
        <React.Fragment key={index}>
          {index > 0 ? <Sep className="shrink-0" /> : null}
          {item}
        </React.Fragment>
      ))}
    </span>
  );
};

/* ------------------------------------------------------------- status line */

/**
 * The bottom line of the screen.
 *
 * Every terminal multiplexer ends its display with one: session facts on the
 * left, the keys that work here on the right. Putting the session's identity
 * down here instead of in a top bar is what frees the top of the window to be
 * nothing but the program's name and its tabs — which is the shape Herdr's own
 * tab bar and status area have.
 */
export const StatusLine: React.FC<{
  left?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}> = ({ left, right, className }) => (
  <footer
    className={cn(
      'relative flex h-[var(--tui-row)] w-full shrink-0 items-center justify-between gap-3 overflow-visible border-t border-tui-border bg-tui-mantle px-2 text-tui-sm',
      className,
    )}
  >
    <div className="flex min-w-0 items-center gap-1.5 text-tui-muted">{left}</div>
    <div className="flex shrink-0 items-center gap-3">{right}</div>
  </footer>
);

/* ----------------------------------------------------------------- appframe */

/**
 * The shape every full-screen view in this client takes.
 *
 * It is the layout of the `herdr-remote` configuration TUI, transposed:
 *
 *     herdr-remote  control the web terminal        ← program line
 *     1 OVERVIEW  2 CLIENTS  3 PTYS                 ← numbered tabs
 *     ┌─ OVERVIEW ──────────────────────┐      ← body, fills the rest
 *     │ mode          local network       │
 *     └──────────────────────────────┘
 *     esc back · enter select                       ← key hints
 *
 * The chrome rows are fixed and only the body scrolls, so the program line and
 * the hints stay where they are put: a terminal never scrolls its own frame
 * away, and a view that did would stop reading as one screen.
 */
export const AppFrame: React.FC<{
  /**
   * The program, bold, first thing on the first line. Omit it where the app's
   * own header already names the view: two title rows stacked on each other
   * are chrome the body pays for and nobody reads.
   */
  name?: string;
  tagline?: React.ReactNode;
  /** Right end of the program line: the tmux-style status area. */
  aside?: React.ReactNode;
  tabs?: TabDescriptor[];
  activeTabId?: string;
  onSelectTab?: (id: string) => void;
  tabsAriaLabel?: string;
  /** Left of the tabs, on their row: a way back. */
  toolbarStart?: React.ReactNode;
  /** Right end of the tab row: the view's own controls. */
  toolbarAside?: React.ReactNode;
  hints?: KeyHint[];
  /** Right end of the hint line. */
  footerAside?: React.ReactNode;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}> = ({
  name,
  tagline,
  aside,
  tabs,
  activeTabId,
  onSelectTab,
  tabsAriaLabel,
  toolbarStart,
  toolbarAside,
  hints,
  footerAside,
  bodyClassName,
  className,
  children,
}) => {
  const hasTabs = Boolean(tabs && tabs.length > 0 && activeTabId !== undefined && onSelectTab);
  return (
    <div className={cn('flex h-full min-h-0 w-full flex-col bg-tui-crust', className)}>
      {name ? (
        <div className="flex h-[var(--tui-row)] shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-tui-border bg-tui-mantle px-2 text-tui">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-bold text-tui-accent">{name}</span>
            {tagline ? (
              <span className="hidden truncate text-tui-sm text-tui-faint sm:block">{tagline}</span>
            ) : null}
          </span>
          {aside ? <span className="flex shrink-0 items-center gap-2">{aside}</span> : null}
        </div>
      ) : null}

      {hasTabs || toolbarStart || toolbarAside ? (
        <div className="flex min-h-[var(--tui-row)] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-tui-border bg-tui-mantle px-2 py-1">
          {toolbarStart ? <div className="flex shrink-0 items-center">{toolbarStart}</div> : null}
          {/* A phone cannot fit the way back, the tabs and the controls on one
              line; the tabs take a line of their own below the other two rather
              than scrolling their last tab out of sight. */}
          {hasTabs ? (
            <div className="scrollbar-none order-last min-w-0 basis-full overflow-x-auto sm:order-none sm:basis-auto">
              <Tabs
                tabs={tabs!}
                activeId={activeTabId!}
                onSelect={onSelectTab!}
                ariaLabel={tabsAriaLabel}
                className="gap-3"
              />
            </div>
          ) : null}
          {toolbarAside ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">{toolbarAside}</div>
          ) : null}
        </div>
      ) : null}

      <div className={cn('min-h-0 flex-1 overflow-y-auto p-2', bodyClassName)}>{children}</div>

      {hints || footerAside ? (
        <StatusLine left={hints ? <KeyHints hints={hints} /> : null} right={footerAside} />
      ) : null}
    </div>
  );
};
