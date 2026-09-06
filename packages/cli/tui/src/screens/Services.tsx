import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Menu, Message, Panel } from '../components/common.js';
import { readLogTail, restartAll, startAll, stopAll } from '../api.js';

const LOG_LINES = 8;

export function Services({ ctx }: { ctx: AppContext }) {
  const { t, run, status } = ctx;
  const [selected, setSelected] = useState('start');

  const items = [
    { id: 'start', label: t('services.start') },
    { id: 'stop', label: t('services.stop') },
    { id: 'restart', label: t('services.restart') },
  ];

  const activate = (id: string) => {
    // Starting or restarting reads the configuration from disk, so doing it on
    // top of an unsaved draft silently applies the old settings — which reads
    // as "I changed the relay and it never took effect". Stopping is unaffected.
    if (ctx.dirty && id !== 'stop') {
      ctx.notify(t('services.unsavedBlocked'), 'error');
      return;
    }
    return run(() => {
    const config = ctx.config;
    if (id === 'start') {
      const result = startAll(config);
      ctx.notify(result.managed ? t('services.managedNotice', { manager: result.manager ?? '' }) : t('services.started'), 'success');
      return;
    }
    if (id === 'stop') {
      const result = stopAll(config);
      ctx.notify(result.managed ? t('services.managedNotice', { manager: result.manager ?? '' }) : t('services.stopped'), 'success');
      return;
    }
    const result = restartAll(config);
    ctx.notify(result.managed ? t('services.managedNotice', { manager: result.manager ?? '' }) : t('services.restarted'), 'success');
    });
  };

  useInput((_input, key) => {
    const index = items.findIndex((item) => item.id === selected);
    if (key.upArrow) setSelected(items[(index - 1 + items.length) % items.length].id);
    else if (key.downArrow) setSelected(items[(index + 1) % items.length].id);
    else if (key.return) activate(selected);
  }, { isActive: ctx.editingId === null });

  const relayLog = readLogTail('relay', LOG_LINES);
  const hostLog = readLogTail('host', LOG_LINES);

  return (
    <Panel title={t('services.title')}>
      <Menu items={items} selectedId={selected} onChange={setSelected} onSelect={activate} />

      {ctx.dirty ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>{t('services.unsavedBlocked')}</Text>
        </Box>
      ) : null}

      {status?.keepalive.installed ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('services.managedNotice', { manager: status.keepalive.manager })}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted}>{t('services.logs')}</Text>
        <LogBlock title={t('services.logRelay')} lines={relayLog} emptyText={t('services.logEmpty')} />
        <LogBlock title={t('services.logHost')} lines={hostLog} emptyText={t('services.logEmpty')} />
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}

function LogBlock({ title, lines, emptyText }: { title: string; lines: string[]; emptyText: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.muted}>{title}</Text>
      {lines.length === 0 ? (
        <Text color={theme.muted}>{emptyText}</Text>
      ) : (
        lines.map((line, index) => (
          // Log lines are positional and may repeat, so the index is the only
          // stable identity available here.
          // eslint-disable-next-line react/no-array-index-key
          <Text key={index} color={theme.muted} wrap="truncate-end">{line}</Text>
        ))
      )}
    </Box>
  );
}
