import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { FieldRow, Message, Panel, Row, Selectable, StatusDot } from '../components/common.js';
import { TextField } from '../components/TextField.js';
import { getField, getFieldPlaceholder, herdrPlugin, saveDraft, setField } from '../api.js';

type Registration = {
  available: boolean;
  registered: boolean;
  enabled?: boolean;
  linkedPath?: string | null;
  stale?: boolean;
  packageRoot?: string;
};

export function HerdrScreen({ ctx }: { ctx: AppContext }) {
  const { t, draft, editingId } = ctx;
  const [selected, setSelected] = useState('socketPath');
  const [registration, setRegistration] = useState<Registration | null>(null);

  const reloadRegistration = () => {
    try {
      setRegistration(herdrPlugin.registrationStatus());
    } catch (error) {
      ctx.notify((error as Error).message, 'error');
    }
  };

  useEffect(reloadRegistration, []);

  const entries = [
    { id: 'socketPath', kind: 'field' as const, label: t('herdr.socketPath') },
    { id: 'herdrArgs', kind: 'field' as const, label: t('herdr.args') },
    { id: 'save', kind: 'action' as const, label: t('common.save') },
    {
      id: registration?.registered && !registration?.stale ? 'unregister' : 'register',
      kind: 'action' as const,
      label: registration?.registered && !registration?.stale ? t('herdr.unregister') : t('herdr.register'),
    },
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
    if (id === 'save') { save(); return; }
    ctx.run(() => {
      try {
        if (id === 'register') {
          const result = herdrPlugin.register();
          ctx.notify(t('herdr.registerDone', { path: result.path }), 'success');
        } else {
          herdrPlugin.unregister();
          ctx.notify(t('herdr.unregisterDone'), 'success');
        }
      } catch (error) {
        const failure = error as Error & { code?: string };
        throw new Error(failure.code === 'HERDR_NOT_FOUND'
          ? t('herdr.cliMissing')
          : t('herdr.registerFailed', { message: failure.message }));
      } finally {
        reloadRegistration();
      }
    });
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
        <Row label={t('herdr.plugin')}>
          <Box>
            <StatusDot level={registration?.registered && !registration?.stale ? 'ok' : registration?.stale ? 'warn' : 'idle'} />
            <Text>
              {' '}
              {registration?.registered ? t('herdr.pluginRegistered') : t('herdr.pluginMissing')}
            </Text>
          </Box>
        </Row>
        {registration?.packageRoot ? (
          <Row label="">
            <Text color={theme.muted}>{registration.packageRoot}</Text>
          </Row>
        ) : null}
        {registration && !registration.available ? (
          <Text color={theme.warn}>{t('herdr.cliMissing')}</Text>
        ) : null}
        {registration?.stale && registration.linkedPath ? (
          // A leftover link to an old source checkout is the usual state after
          // switching to the npm install; re-registering repoints it.
          <Text color={theme.warn}>{registration.linkedPath}</Text>
        ) : null}
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
