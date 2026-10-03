import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Message, Panel, Row, Selectable } from '../components/common.js';
import {
  canSelfUpdate,
  cliTarballUrl,
  checkForUpdate,
  configPath,
  currentVersion,
  detectLocale,
  installKind,
  installedRelayVersion,
  performUpdate,
  runsLocalRelay,
  saveDraft,
  setField,
  stateDir,
  type UpdateCheck,
  whileServicesStopped,
} from '../api.js';

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; latest: string }
  | { phase: 'available'; latest: string }
  | { phase: 'updating'; latest: string; attempt: number }
  | { phase: 'done'; latest: string }
  | { phase: 'error'; messageKey: string; params?: Record<string, string | number> };

/** Where the last check found the release, reused by the install. */
type CheckRef = { current: { source: string } };

export function About({ ctx }: { ctx: AppContext }) {
  const { t, draft } = ctx;
  const [selected, setSelected] = useState('auto');
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  const checkRef = useState<CheckRef>(() => ({ current: { source: '' } }))[0];

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
      case 'checking':
        return t('update.checking');
      case 'current':
        return t('update.upToDate', { version: update.latest });
      case 'available':
        return t('update.available', { version: update.latest });
      case 'updating':
        return update.attempt > 1
          ? t('update.updatingRetry', { version: update.latest, attempt: update.attempt })
          : t('update.updating', { version: update.latest });
      case 'done':
        return t('update.done', { version: update.latest });
      case 'error':
        return t(update.messageKey, update.params);
      default:
        return t('update.check');
    }
  })();

  const options = [...languageOptions, { id: 'update', label: updateLabel }];

  /** Show a check's answer, whether this screen asked or the TUI did on opening. */
  const applyCheck = (result: UpdateCheck) => {
    checkRef.current = { source: result.source ?? '' };
    setUpdate(
      result.updateAvailable
        ? { phase: 'available', latest: result.latest as string }
        : { phase: 'current', latest: result.latest as string },
    );
  };

  // The TUI already asked when it opened; start from that answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new answer from the opening check matters, not each render's applyCheck or phase
  useEffect(() => {
    if (ctx.updateCheck?.ok && update.phase === 'idle') applyCheck(ctx.updateCheck);
  }, [ctx.updateCheck]);

  const runCheck = async () => {
    setUpdate({ phase: 'checking' });
    const result: UpdateCheck = await checkForUpdate();
    if (!result.ok) {
      setUpdate({ phase: 'error', messageKey: result.errorKey ?? 'update.errorNetwork' });
      // Which sources were tried, and what each of them said. Without this
      // the row reads "could not reach npm registry" on a machine where
      // `npm install` works perfectly, and there is nothing to act on.
      const { message } = result;
      if (message) ctx.notify((t) => t('update.errorNetworkDetail', { message }), 'error');
      return;
    }
    ctx.setUpdateCheck(result);
    applyCheck(result);
  };

  const runUpdate = async (latest: string) => {
    setUpdate({ phase: 'updating', latest, attempt: 1 });
    const result = await whileServicesStopped(ctx.config, () =>
      performUpdate({
        source: checkRef.current.source,
        version: latest,
        onAttempt: ({ attempt }: { attempt: number }) =>
          setUpdate({ phase: 'updating', latest, attempt }),
      }),
    );
    if (!result.ok) {
      const params = {
        version: latest,
        installed: result.installed ?? '',
        url: cliTarballUrl(latest),
      };
      setUpdate({ phase: 'error', messageKey: result.errorKey ?? 'update.errorFailed', params });
      // npm's own words: "update failed" alone is what left this unfixable.
      ctx.notify(
        (t) =>
          result.summary
            ? t('update.errorFailedDetail', { message: result.summary })
            : t(result.errorKey ?? 'update.errorFailed', params),
        'error',
      );
      return;
    }
    setUpdate({ phase: 'done', latest });
    // Installed: the line under the title has nothing left to announce.
    ctx.setUpdateCheck(null);
    ctx.notify((t) => t('update.restartHint'), 'success');
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
    const { errorKey } = result;
    if (errorKey) {
      ctx.notify((t) => t(errorKey), 'error');
      return;
    }
    ctx.updateDraft(result.draft);
    try {
      saveDraft(result.draft);
      ctx.reloadConfig();
      ctx.notify((t) => t('common.saved', { path: configPath() }), 'success');
    } catch (error) {
      ctx.notify((t) => t('error.saveFailed', { message: (error as Error).message }), 'error');
    }
  };

  const activate = (id: string) => {
    if (id === 'update') {
      activateUpdate();
      return;
    }
    choose(id);
  };

  useInput(
    (_input, key) => {
      const index = options.findIndex((option) => option.id === selected);
      if (key.upArrow) setSelected(options[(index - 1 + options.length) % options.length].id);
      else if (key.downArrow) setSelected(options[(index + 1) % options.length].id);
      else if (key.return) activate(selected);
    },
    { isActive: ctx.editingId === null },
  );

  return (
    <Panel title={t('about.title')}>
      <Text color={theme.muted}>{t('about.language')}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {languageOptions.map((option) => (
          <Selectable
            key={option.id}
            selected={selected === option.id}
            onSelect={() => {
              setSelected(option.id);
              choose(option.id);
            }}
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
          onSelect={() => {
            setSelected('update');
            activateUpdate();
          }}
          onHover={() => setSelected('update')}
        >
          {updateLabel}
        </Selectable>
      </Box>

      <Row label={t('about.version')}>
        <Text color={theme.muted}>{currentVersion()}</Text>
      </Row>
      {runsLocalRelay(ctx.config) ? (
        <Row label={t('about.relayPackage')}>
          <Text color={theme.muted}>{installedRelayVersion() ?? '?'}</Text>
        </Row>
      ) : null}
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
