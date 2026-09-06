import { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { Button, GLYPH, Input } from './tui';

interface VirtualKeyboardHelperProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Commands short enough to be worth a tap instead of a phone keyboard. */
const QUICK_COMMANDS = ['ls -la', 'clear', 'git status', 'pwd', 'top', 'exit', 'cat'];

/**
 * A prompt line for devices whose keyboard is slow to reach.
 *
 * It is written as a prompt, `$ ▸ …`, because that is what it is: a place to
 * compose one command and send it. The suggestions above it are the shell
 * history a terminal would offer, not a row of buttons.
 */
export const VirtualKeyboardHelper: React.FC<VirtualKeyboardHelperProps> = ({
  isOpen,
  onClose,
}) => {
  const { sendKey, isController, warnViewerMode, t } = useTerminal();
  const [text, setText] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!isController) {
      warnViewerMode();
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
      warnViewerMode();
      return;
    }
    sendKey(snippet + '\r');
  };

  return (
    <div
      className="z-20 flex flex-col gap-1.5 border-t border-tui-border bg-tui-mantle p-2"
      role="region"
      aria-label={t('virtualKeyboard.helperTitle')}
    >
      <div className="flex items-center justify-between">
        <span className="text-tui font-bold uppercase text-tui-accent">
          {t('virtualKeyboard.helperTitle')}
        </span>
        <Button variant="ghost" onClick={onClose} aria-label={t('virtualKeyboard.closeHelper')}>
          esc
        </Button>
      </div>

      <div className="scrollbar-none flex items-center gap-1 overflow-x-auto py-0.5">
        {QUICK_COMMANDS.map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => handleQuickSnippet(cmd)}
            className="tui-focusable shrink-0 select-none border border-tui-border bg-tui-surface px-2 py-0.5 text-tui-sm text-tui-muted transition-colors hover:border-tui-accent hover:text-tui-accent"
          >
            {cmd}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
        <span aria-hidden="true" className="shrink-0 select-none font-bold text-tui-ok">
          $
        </span>
        <div className="relative flex-1">
          <label htmlFor="virtual-keyboard-input" className="sr-only">
            {t('virtualKeyboard.placeholder')}
          </label>
          <Input
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
            /* 16px on a phone, or iOS zooms the whole page on focus. */
            className="select-text pr-7"
          />
          {text.length > 0 && (
            <button
              type="button"
              onClick={() => setText('')}
              className="tui-focusable absolute right-1 top-1/2 -translate-y-1/2 px-1 text-tui-faint hover:text-tui-bad"
              aria-label={t('virtualKeyboard.clearInput')}
            >
              <span aria-hidden="true">{GLYPH.cross}</span>
            </button>
          )}
        </div>

        <Button
          variant="primary"
          type="submit"
          title={t('virtualKeyboard.sendButton')}
          glyph="⏎"
          className="h-9 shrink-0"
        >
          <span className="hidden sm:inline">{t('virtualKeyboard.sendButton')}</span>
        </Button>
      </form>
    </div>
  );
};
