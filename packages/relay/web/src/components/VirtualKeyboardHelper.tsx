import { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { CornerDownLeft, X, Sparkles } from 'lucide-react';

interface VirtualKeyboardHelperProps {
  isOpen: boolean;
  onClose: () => void;
}

export const VirtualKeyboardHelper: React.FC<VirtualKeyboardHelperProps> = ({
  isOpen,
  onClose,
}) => {
  const { sendKey, isController, addToast, t } = useTerminal();
  const [text, setText] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!isController) {
      addToast('warning', t('toasts.viewerModeWarning'));
      return;
    }

    if (text.length > 0) {
      sendKey(text + '\r');
      setText('');
    } else {
      sendKey('\r');
    }
  };

  const handleQuickSnippet = (snippet: string) => {
    if (!isController) {
      addToast('warning', t('toasts.viewerModeWarning'));
      return;
    }
    sendKey(snippet + '\r');
  };

  return (
    <div
      className="bg-paper/95 dark:bg-charcoal-900/95 border-t border-sand-300 dark:border-charcoal-700 p-2.5 z-20 flex flex-col gap-2 shadow-2xl animate-in slide-in-from-bottom-2 backdrop-blur-md"
      role="region"
      aria-label={t('virtualKeyboard.helperTitle')}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-herdr-700 dark:text-herdr-400 font-semibold flex items-center gap-1">
          <Sparkles className="w-3 h-3" /> {t('virtualKeyboard.helperTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 p-1 rounded focus:outline-none"
          aria-label={t('virtualKeyboard.closeHelper')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Quick common command pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5 text-xs">
        {['ls -la', 'clear', 'git status', 'pwd', 'top', 'exit', 'cat'].map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => handleQuickSnippet(cmd)}
            className="px-2.5 py-1 rounded-lg bg-sand-100 hover:bg-sand-200 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-charcoal-800 dark:text-charcoal-200 font-mono text-[11px] border border-sand-300 dark:border-charcoal-700 flex-shrink-0 transition-colors shadow-sm"
          >
            {cmd}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <label htmlFor="virtual-keyboard-input" className="sr-only">
            {t('virtualKeyboard.placeholder')}
          </label>
          <input
            id="virtual-keyboard-input"
            name="terminal-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('virtualKeyboard.placeholder')}
            inputMode="text"
            enterKeyHint="send"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full select-text bg-sand-50 dark:bg-charcoal-950 border border-sand-300 dark:border-charcoal-700 rounded-xl px-3 py-2 text-base sm:text-sm text-charcoal-900 dark:text-charcoal-100 font-mono placeholder:text-charcoal-400 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
          />
          {text.length > 0 && (
            <button
              type="button"
              onClick={() => setText('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-600 p-1"
              aria-label={t('virtualKeyboard.clearInput')}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <button
          type="submit"
          className="h-9 px-3.5 rounded-xl bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white text-xs font-semibold flex items-center gap-1 transition-colors flex-shrink-0 shadow-sm"
          title={t('virtualKeyboard.sendButton')}
        >
          <CornerDownLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t('virtualKeyboard.sendButton')}</span>
        </button>
      </form>
    </div>
  );
};
