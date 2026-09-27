import type React from 'react';
import { useState } from 'react';
import { useSettings } from '@/context/TerminalContext';
import { GLYPH } from '@/shared/ui';

/**
 * Fields most people never need, folded behind a `▸` the way a TUI folds a
 * section. Closed each time its dialog opens: the dialog unmounts it.
 */
export const AdvancedFields: React.FC<{ hint: string; children: React.ReactNode }> = ({
  hint,
  children,
}) => {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-tui-border-dim">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="tui-focusable flex w-full items-center gap-2 px-2 py-1 text-left text-tui text-tui-muted transition-colors hover:text-tui-accent"
      >
        <span aria-hidden="true" className="text-tui-accent">
          {open ? GLYPH.chevronDown : GLYPH.chevronRight}
        </span>
        <span>{t('pairing.advancedTitle')}</span>
        <span className="min-w-0 truncate text-tui-sm text-tui-faint">{hint}</span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-tui-border-dim px-2 py-2">{children}</div>
      )}
    </div>
  );
};
