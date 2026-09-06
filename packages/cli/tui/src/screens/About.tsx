import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Message, Panel, Row, Selectable } from '../components/common.js';
import {
  canSelfUpdate,
  checkForUpdate,
  configPath,
  detectLocale,
  installKind,
  performUpdate,
  saveDraft,
  setField,
  stateDir,
} from '../api.js';

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; latest: string }
  | { phase: 'available'; latest: string }
  | { phase: 'updating'; latest: string }
  | { phase: 'done'; latest: string }
  | { phase: 'error'; messageKey: string };

// Injected at build time by scripts/build-tui.mjs.
declare const __APP_VERSION__: string;

export function About({ ctx }: { ctx: AppContext }) {
  const { t, draft } = ctx;
  const [selected, setSelected] = useState('auto');
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });

  const detected = detectLocale({ preference: 'auto' });
  const languageOptions = [
    { id: 'auto', label: t('about.languageAuto', { detected }) },
    { id: 'zh', label: t('about.languageZh') },
    { id: 'en', label: t('about.languageEn') },
  ];

  // The update row is a selectable option alongside the languages, so one set
  // of arrow keys drives the whole screen.
  const updatable = canSelfUpdate();
  const updateLabel = (() => {
    switch (update.phase) {
      case 'checking': return t('update.checking');
      case 'current': return t('update.upToDate', { version: update.latest });
      case 'available': return t('update.available', { version: update.latest });
      case 'updating': return t('update.updating', { version: update.latest });
      case 'done': return t('update.done', { version: update.latest });
      case 'error': return t(update.messageKey);
      default: return t('update.check');
    }
  })();

  const options = [...languageOptions, { id: 'update', label: updateLabel }];

  const runCheck = async () => {
    setUpdate({ phase: 'checking' });
    const result = await checkForUpdate();
    if (!result.ok) {
      setUpdate({ phase: 'error', messageKey: result.errorKey ?? 'update.errorNetwork' });
      return;
    }
    setUpdate(result.updateAvailable
      ? { phase: 'available', latest: result.latest as string }
      : { phase: 'current', latest: result.latest as string });
  };

  const runUpdate = async (latest: string) => {
    setUpdate({ phase: 'updating', latest });
    const result = await performUpdate();
    if (!result.ok) {
      setUpdate({ phase: 'error', messageKey: result.errorKey ?? 'update.errorFailed' });
      ctx.notify(t('update.errorFailed'), 'error');
      return;
    }
    setUpdate({ phase: 'done', latest });
    ctx.notify(t('update.restartHint'), 'success');
  };

  /**
   * One row, two meanings: check first, then install what the check found.
   * Refusing to self-update is reported rather than hidden, so a checkout does
   * not look like a silently broken button.
   */
  const activateUpdate = () => {
    if (update.phase === 'checking' || update.phase === 'updating') return;
    if (update.phase === 'available') {
      if (!updatable) {
        setUpdate({ phase: 'error', messageKey: `update.cannot.${installKind()}` });
        return;
      }
      void runUpdate(update.latest);
      return;
    }
    void runCheck();
  };

  const choose = (language: string) => {
    const result = setField(draft, 'language', language);
    if (result.errorKey) { ctx.notify(t(result.errorKey), 'error'); return; }
    ctx.updateDraft(result.draft);
    try {
      saveDraft(result.draft);
      ctx.reloadConfig();
      ctx.notify(t('common.saved', { path: configPath() }), 'success');
    } catch (error) {
      ctx.notify(t('error.saveFailed', { message: (error as Error).message }), 'error');
    }
  };

  const activate = (id: string) => {
    if (id === 'update') { activateUpdate(); return; }
    choose(id);
  };

  useInput((_input, key) => {
    const index = options.findIndex((option) => option.id === selected);
    if (key.upArrow) setSelected(options[(index - 1 + options.length) % options.length].id);
    else if (key.downArrow) setSelected(options[(index + 1) % options.length].id);
    else if (key.return) activate(selected);
  }, { isActive: ctx.editingId === null });

  return (
    <Panel title={t('about.title')}>
      <Text color={theme.muted}>{t('about.language')}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {languageOptions.map((option) => (
          <Selectable
            key={option.id}
            selected={selected === option.id}
            onSelect={() => { setSelected(option.id); choose(option.id); }}
            onHover={() => setSelected(option.id)}
          >
            {`${option.label}${draft.ui.language === option.id ? '  ✓' : ''}`}
          </Selectable>
        ))}
      </Box>

      <Text color={theme.muted}>{t('update.title')}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Selectable
          selected={selected === 'update'}
          onSelect={() => { setSelected('update'); activateUpdate(); }}
          onHover={() => setSelected('update')}
        >
          {updateLabel}
        </Selectable>
      </Box>

      <Row label={t('about.version')}>
        <Text color={theme.muted}>{__APP_VERSION__}</Text>
      </Row>
      <Row label={t('about.configPath')}>
        <Text color={theme.muted}>{configPath()}</Text>
      </Row>
      <Row label={t('about.statePath')}>
        <Text color={theme.muted}>{stateDir()}</Text>
      </Row>

      <Box marginTop={1}>
        <Text color={theme.muted}>{t('about.docs')}</Text>
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
