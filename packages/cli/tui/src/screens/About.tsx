import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Message, Panel, Row, Selectable } from '../components/common.js';
import { configPath, detectLocale, saveDraft, setField, stateDir } from '../api.js';

// Injected at build time by scripts/build-tui.mjs.
declare const __APP_VERSION__: string;

export function About({ ctx }: { ctx: AppContext }) {
  const { t, draft } = ctx;
  const [selected, setSelected] = useState('auto');

  const detected = detectLocale({ preference: 'auto' });
  const options = [
    { id: 'auto', label: t('about.languageAuto', { detected }) },
    { id: 'zh', label: t('about.languageZh') },
    { id: 'en', label: t('about.languageEn') },
  ];

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

  useInput((_input, key) => {
    const index = options.findIndex((option) => option.id === selected);
    if (key.upArrow) setSelected(options[(index - 1 + options.length) % options.length].id);
    else if (key.downArrow) setSelected(options[(index + 1) % options.length].id);
    else if (key.return) choose(selected);
  }, { isActive: ctx.editingId === null });

  return (
    <Panel title={t('about.title')}>
      <Text color={theme.muted}>{t('about.language')}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {options.map((option) => (
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
