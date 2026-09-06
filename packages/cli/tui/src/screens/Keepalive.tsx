import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Message, Panel, Row, Selectable, StatusDot } from '../components/common.js';
import { ChoiceList } from './Relay.js';
import { keepalive, saveDraft, setField } from '../api.js';

const MANAGERS = ['auto', 'systemd', 'launchd', 'supervisor', 'none'];

export function Keepalive({ ctx }: { ctx: AppContext }) {
  const { t, status, draft, editingId } = ctx;
  const [selected, setSelected] = useState('install');

  const current = status?.keepalive;
  const entries = [
    { id: 'install', label: t('keepalive.install') },
    { id: 'restart', label: t('keepalive.restart') },
    { id: 'uninstall', label: t('keepalive.uninstall') },
    { id: 'manager', label: `${t('keepalive.manager')}: ${draft.keepalive.manager}` },
    ...(process.platform === 'linux' && current?.manager === 'systemd' && !current?.linger
      ? [{ id: 'linger', label: t('keepalive.enableLinger') }]
      : []),
  ];

  const activate = (id: string) => {
    if (id === 'manager') { ctx.setEditing('keepaliveManager'); return; }
    ctx.run(() => {
      if (id === 'install') {
        const result = keepalive.install(ctx.config);
        ctx.notify(t('keepalive.installed', { manager: result.manager }), 'success');
        return;
      }
      if (id === 'uninstall') {
        keepalive.uninstall(ctx.config);
        ctx.notify(t('keepalive.uninstalled'), 'success');
        return;
      }
      if (id === 'restart') {
        keepalive.restart(ctx.config);
        ctx.notify(t('keepalive.restarted'), 'success');
        return;
      }
      if (id === 'linger') {
        const result = keepalive.enableLinger();
        ctx.notify(t('keepalive.lingerDone', { username: result.username }), 'success');
      }
    });
  };

  useInput((_input, key) => {
    const index = entries.findIndex((entry) => entry.id === selected);
    if (key.upArrow) setSelected(entries[(index - 1 + entries.length) % entries.length].id);
    else if (key.downArrow) setSelected(entries[(index + 1) % entries.length].id);
    else if (key.return) activate(selected);
  }, { isActive: editingId === null });

  if (editingId === 'keepaliveManager') {
    return (
      <Panel title={t('field.keepalive')}>
        <ChoiceList
          options={MANAGERS.map((manager) => ({ id: manager, label: manager }))}
          current={draft.keepalive.manager}
          onPick={(manager) => {
            const result = setField(draft, 'keepaliveManager', manager);
            if (result.errorKey) { ctx.notify(t(result.errorKey), 'error'); return; }
            ctx.updateDraft(result.draft);
            try {
              saveDraft(result.draft);
              ctx.reloadConfig();
            } catch (error) {
              ctx.notify(t('error.saveFailed', { message: (error as Error).message }), 'error');
            }
            ctx.setEditing(null);
          }}
          onCancel={() => ctx.setEditing(null)}
        />
      </Panel>
    );
  }

  return (
    <Panel title={t('keepalive.title')}>
      <Row label={t('keepalive.manager')}>
        <Text>{current?.manager ?? t('common.unknown')}</Text>
      </Row>
      <Row label={t('keepalive.state')}>
        <Box>
          <StatusDot level={current?.active ? 'ok' : current?.installed ? 'warn' : 'idle'} />
          <Text>
            {' '}
            {current?.active ? t('common.running') : current?.installed ? t('common.installed') : t('common.notInstalled')}
          </Text>
        </Box>
      </Row>
      {current?.unitPath ? (
        <Row label={t('keepalive.unitPath')}>
          <Text color={theme.muted}>{current.unitPath}</Text>
        </Row>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {entries.map((entry) => (
          <Selectable
            key={entry.id}
            selected={selected === entry.id}
            onSelect={() => { setSelected(entry.id); activate(entry.id); }}
            onHover={() => setSelected(entry.id)}
          >
            {entry.label}
          </Selectable>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {current?.manager === 'systemd' ? (
          <Text color={current.linger ? theme.muted : theme.warn}>
            {current.linger ? t('keepalive.lingerEnabled') : t('keepalive.lingerDisabled')}
          </Text>
        ) : null}
        {current?.manager === 'supervisor' ? (
          <Text color={theme.warn}>{t('keepalive.fallbackNote')}</Text>
        ) : null}
        <Text color={theme.muted}>{t('keepalive.logsHint', { command: status?.logsHint ?? '' })}</Text>
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
