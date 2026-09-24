import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { FieldRow, Message, Panel, Row, Selectable, StatusDot } from '../components/common.js';
import { TextField } from '../components/TextField.js';
import { MIN_HERDR_VERSION, getField, getFieldPlaceholder, herdrVersion, saveDraft, setField } from '../api.js';

type InstalledHerdr = {
  /** False when no herdr executable answered. */
  ok: boolean;
  version: string | null;
  supported: boolean;
};

export function HerdrScreen({ ctx }: { ctx: AppContext }) {
  const { t, draft, editingId } = ctx;
  const [selected, setSelected] = useState('socketPath');
  const [installed, setInstalled] = useState<InstalledHerdr | null>(null);

  useEffect(() => {
    setInstalled(herdrVersion());
  }, []);

  const entries = [
    { id: 'socketPath', kind: 'field' as const, label: t('herdr.socketPath') },
    { id: 'herdrArgs', kind: 'field' as const, label: t('herdr.args') },
    { id: 'save', kind: 'action' as const, label: t('common.save') },
  ];

  const applyField = (id: string, value: string) => {
    const result = setField(draft, id, value);
    if (result.errorKey) { ctx.notify(t(result.errorKey), 'error'); return false; }
    ctx.updateDraft(result.draft);
    return true;
  };

  const save = () => {
    try {
      const result = saveDraft(draft);
      ctx.reloadConfig();
      ctx.notify(t('common.saved', { path: result.path }), 'success');
    } catch (error) {
      ctx.notify(t('error.saveFailed', { message: (error as Error).message }), 'error');
    }
  };

  const activate = (id: string) => {
    if (id === 'socketPath' || id === 'herdrArgs') { ctx.setEditing(id); return; }
    if (id === 'save') save();
  };

  useInput((input, key) => {
    const index = entries.findIndex((entry) => entry.id === selected);
    const safeIndex = index >= 0 ? index : 0;
    if (key.upArrow) setSelected(entries[(safeIndex - 1 + entries.length) % entries.length].id);
    else if (key.downArrow) setSelected(entries[(safeIndex + 1) % entries.length].id);
    else if (key.return) activate(selected);
    else if (input === 's') save();
  }, { isActive: editingId === null });

  return (
    <Panel title={t('herdr.title')}>
      {entries.map((entry) => (
        entry.kind === 'field' ? (
          <FieldRow
            key={entry.id}
            label={entry.label}
            selected={selected === entry.id}
            onSelect={() => activate(entry.id)}
            onHover={() => setSelected(entry.id)}
          >
            <TextField
              value={getField(draft, entry.id)}
              placeholder={ctx.t(getFieldPlaceholder(draft, entry.id))}
              active={editingId === entry.id}
              onSubmit={(value) => { if (applyField(entry.id, value)) ctx.setEditing(null); }}
              onCancel={() => ctx.setEditing(null)}
            />
          </FieldRow>
        ) : (
          <Box key={entry.id} marginTop={1}>
            <Selectable
              selected={selected === entry.id}
              onSelect={() => { setSelected(entry.id); activate(entry.id); }}
              onHover={() => setSelected(entry.id)}
            >
              {entry.label}
            </Selectable>
          </Box>
        )
      ))}

      {ctx.dirty ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>{t('hint.unsavedChanges')}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {installed?.version ? (
          <Row label={t('herdr.version')}>
            <Box>
              <StatusDot level={installed.supported ? 'ok' : 'warn'} />
              <Text>{` ${installed.version}`}</Text>
            </Box>
          </Row>
        ) : null}
        {installed?.version && !installed.supported ? (
          <Text color={theme.warn}>
            {t('herdr.versionOutdated', { version: installed.version, minimum: MIN_HERDR_VERSION })}
          </Text>
        ) : null}
        {installed && !installed.ok ? (
          <Text color={theme.warn}>{t('herdr.cliMissing')}</Text>
        ) : null}
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
