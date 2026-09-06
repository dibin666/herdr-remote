import { useCallback } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { translate, Language } from './index';

export function useI18n() {
  const { settings, updateSettings } = useTerminal();
  const language = settings.language;

  const t = useCallback(
    (path: string, params?: Record<string, string | number>) => {
      return translate(language, path, params);
    },
    [language]
  );

  const setLanguage = useCallback(
    (nextLang: Language) => {
      updateSettings({ language: nextLang });
    },
    [updateSettings]
  );

  return { t, language, setLanguage };
}
