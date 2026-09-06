import React from 'react';
import { Box, Text } from 'ink';
import type { AppContext } from '../App.js';
import { theme, type StatusLevel } from '../theme.js';
import { Message, Panel, Row, StatusDot } from '../components/common.js';
import { formatUptime } from '../api.js';

function level(alive: boolean | null | undefined): StatusLevel {
  if (alive === null || alive === undefined) return 'idle';
  return alive ? 'ok' : 'bad';
}

export function Overview({ ctx }: { ctx: AppContext }) {
  const { t, status, config } = ctx;

  if (!status) {
    return (
      <Panel title={t('overview.title')}>
        <Text color={theme.muted}>{t('common.loading')}</Text>
      </Panel>
    );
  }

  const health = status.relay.health || {};
  const relayReachable = health.ok !== false;
  const relayLevel: StatusLevel = status.relay.local
    ? level(status.relay.alive)
    : relayReachable ? 'ok' : 'bad';
  const keepaliveLevel: StatusLevel = status.keepalive.active
    ? 'ok'
    : status.keepalive.installed ? 'warn' : 'idle';
  const nothingRunning = !status.host.alive && (status.relay.local ? !status.relay.alive : !relayReachable);

  return (
    <Panel title={t('overview.title')}>
      <Row label={t('overview.mode')}>
        <Text>{t(`mode.${status.mode}`)}</Text>
      </Row>

      <Row label={t('overview.relay')}>
        <Box>
          <StatusDot level={relayLevel} />
          <Text>
            {' '}
            {status.relay.local
              ? t('overview.relayLocal', { bind: status.relay.bind ?? '', port: status.relay.port })
              : t('overview.relayRemote', { url: status.relay.remoteUrl ?? '' })}
          </Text>
          {status.relay.local && status.relay.pid ? (
            <Text color={theme.muted}>{`  ${t('common.pid', { pid: status.relay.pid })}`}</Text>
          ) : null}
        </Box>
      </Row>

      <Row label={t('overview.host')}>
        <Box>
          <StatusDot level={level(status.host.alive)} />
          <Text>{` ${status.host.alive ? t('common.running') : t('common.stopped')}`}</Text>
          {status.host.pid ? <Text color={theme.muted}>{`  ${t('common.pid', { pid: status.host.pid })}`}</Text> : null}
        </Box>
      </Row>

      <Row label={t('overview.socket')}>
        <Box>
          <StatusDot level={status.host.socketExists ? 'ok' : 'warn'} />
          <Text color={theme.muted}>{` ${status.host.socketPath}`}</Text>
          {status.host.socketExists ? null : <Text color={theme.warn}>{`  ${t('overview.socketMissing')}`}</Text>}
        </Box>
      </Row>

      <Row label={t('overview.webUrl')}>
        <Text color={theme.accent}>{status.publicUrl}</Text>
      </Row>

      <Row label={t('overview.keepalive')}>
        <Box>
          <StatusDot level={keepaliveLevel} />
          <Text>
            {` ${status.keepalive.manager} — `}
            {status.keepalive.active
              ? t('common.running')
              : status.keepalive.installed ? t('common.installed') : t('common.notInstalled')}
          </Text>
        </Box>
      </Row>

      <Box marginTop={1} flexDirection="column">
        {relayReachable ? (
          <>
            <Row label={t('overview.hosts')}>
              <Text>{health.hosts ?? 0}</Text>
            </Row>
            <Row label={t('overview.devices')}>
              <Text>{health.clients ?? 0}</Text>
            </Row>
            <Row label={t('overview.uptime')}>
              <Text color={theme.muted}>{formatUptime(health.uptimeSeconds, t)}</Text>
            </Row>
          </>
        ) : (
          <Text color={theme.warn}>{t('overview.unreachable', { message: health.message ?? '' })}</Text>
        )}
      </Box>

      {nothingRunning ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('overview.notStarted')}</Text>
        </Box>
      ) : null}

      {config.relay.mode === 'local' ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('mode.local.description')}</Text>
        </Box>
      ) : null}

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
