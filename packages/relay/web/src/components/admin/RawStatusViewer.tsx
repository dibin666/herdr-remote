import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, Code } from 'lucide-react';
import { useTerminal } from '../../context/TerminalContext';

interface RawStatusViewerProps {
  data: unknown;
}

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
    <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 bg-sand-50 dark:bg-charcoal-900 flex items-center justify-between text-left hover:bg-sand-100 dark:hover:bg-charcoal-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-herdr-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-charcoal-400" />
          )}
          <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 uppercase tracking-wider flex items-center gap-1.5">
            <Code className="w-3.5 h-3.5 text-herdr-500" />
            <span>{t('admin.rawPayloadTitle')}</span>
          </span>
        </div>
        <span className="text-[11px] text-charcoal-500 dark:text-charcoal-400 font-mono">
          {jsonString.length} bytes
        </span>
      </button>

      {isOpen && (
        <div className="p-4 bg-sand-50 dark:bg-charcoal-900 border-t border-sand-200 dark:border-charcoal-750 relative animate-in slide-in-from-top-1">
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-6 right-6 px-2.5 py-1 rounded-lg bg-paper dark:bg-charcoal-800 hover:bg-sand-200 dark:hover:bg-charcoal-700 text-charcoal-700 dark:text-charcoal-200 text-xs flex items-center gap-1 border border-sand-300 dark:border-charcoal-700 transition-colors shadow-sm"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? t('admin.copiedJson') : t('admin.copyJson')}</span>
          </button>
          <pre className="text-charcoal-800 dark:text-charcoal-200 font-mono text-[11px] overflow-x-auto p-2 leading-relaxed max-h-96">
            <code>{jsonString}</code>
          </pre>
        </div>
      )}
    </div>
  );
};
