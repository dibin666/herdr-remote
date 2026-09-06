import React, { useState } from 'react';
import { useTerminal } from '../../context/TerminalContext';
import { Button, GLYPH } from '../tui';

interface RawStatusViewerProps {
  data: unknown;
}

/**
 * The response, unformatted, behind a disclosure.
 *
 * This is the `cat` at the bottom of a status screen: everything the dashboard
 * summarised, in the form the relay actually sent it, for when a summary is not
 * what you need.
 */
export const RawStatusViewer: React.FC<RawStatusViewerProps> = ({ data }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { addToast, t } = useTerminal();

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString).then(() => {
      setCopied(true);
      addToast('info', t('toasts.rawJsonCopied'));
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="border border-tui-border bg-tui-base">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="tui-focusable flex w-full items-center justify-between gap-2 bg-tui-mantle px-2 py-1 text-left transition-colors hover:bg-tui-selection"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-tui-accent">
            {isOpen ? GLYPH.chevronDown : GLYPH.chevronRight}
          </span>
          <span className="truncate text-tui font-bold text-tui-muted">
            {t('admin.rawPayloadTitle')}
          </span>
          <code className="hidden shrink-0 text-tui-sm text-tui-faint sm:inline">
            GET /api/status
          </code>
        </span>
        <span className="shrink-0 text-tui-sm text-tui-faint">
          {t('admin.payloadBytes', { count: jsonString.length })}
        </span>
      </button>

      {isOpen && (
        <div className="relative border-t border-tui-border-dim">
          <div className="flex items-center justify-end border-b border-tui-border-dim bg-tui-mantle px-2 py-1">
            <Button
              onClick={handleCopy}
              glyph={copied ? GLYPH.check : '⧉'}
              className={copied ? 'border-tui-ok text-tui-ok' : undefined}
            >
              {copied ? t('admin.copiedJson') : t('admin.copyJson')}
            </Button>
          </div>
          <pre className="max-h-96 overflow-auto bg-tui-crust px-2 py-1.5 text-tui-sm leading-relaxed text-tui-muted">
            <code>{jsonString}</code>
          </pre>
        </div>
      )}
    </div>
  );
};
