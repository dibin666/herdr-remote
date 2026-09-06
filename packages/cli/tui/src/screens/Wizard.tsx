import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { FieldRow, Message, Panel, Selectable } from '../components/common.js';
import { TextField } from '../components/TextField.js';
import { ChoiceList } from './Relay.js';
import {
  OFFICIAL_RELAY_URL,
  configPath,
  keepalive,
  listReachableAddresses,
  loadConfig,
  saveDraft,
  setField,
  setRelayPassword,
  startAll,
  type AccessMode,
  type NetworkAddress,
} from '../api.js';

export type StepId = 'language' | 'access' | 'address' | 'relayUrl' | 'password' | 'finish';

/** The questions worth asking for a given access mode, in order. */
export function stepsFor(mode: AccessMode): StepId[] {
  const steps: StepId[] = ['language', 'access'];
  if (mode === 'lan') steps.push('address');
  if (mode === 'remote') steps.push('relayUrl', 'password');
  steps.push('finish');
  return steps;
}

/**
 * First-run setup.
 *
 * The one decision a new install cannot make for the user is how they intend to
 * reach the machine, because it decides whether anything listens beyond
 * loopback. Asking once, up front, beats a default that is either useless on a
 * phone or wider than the user expected.
 */
export function Wizard({ ctx, onDone }: { ctx: AppContext; onDone: () => void }) {
  const { t, draft, editingId } = ctx;
  const [step, setStep] = useState<StepId>('language');
  const [password, setPassword] = useState(ctx.runtime.relayPassword || '');
  const [startNow, setStartNow] = useState(true);
  const [installKeepalive, setInstallKeepalive] = useState(true);
  const [finishSelection, setFinishSelection] = useState('startNow');

  const addresses: NetworkAddress[] = useMemo(
    () => listReachableAddresses({ includeLoopback: false }),
    [],
  );

  const steps: StepId[] = useMemo(() => stepsFor(draft.relay.mode), [draft.relay.mode]);
  const stepIndex = Math.max(0, steps.indexOf(step));

  const apply = (id: string, value: string) => {
    const result = setField(draft, id, value);
    if (result.errorKey) { ctx.notify(t(result.errorKey), 'error'); return false; }
    ctx.updateDraft(result.draft);
    ctx.notify('', 'info');
    return true;
  };

  /**
   * Move to the next step.
   *
   * `order` is passed explicitly by the access step because the step list
   * depends on the mode that was just chosen, and the draft holding it has not
   * re-rendered yet — reading the memo here would use the previous mode and
   * skip straight past the relay questions.
   */
  const advance = (from: StepId, order: StepId[] = steps) => {
    const index = order.indexOf(from);
    setStep(order[Math.min(order.length - 1, index + 1)]);
  };

  const back = () => {
    const index = steps.indexOf(step);
    if (index > 0) setStep(steps[index - 1]);
  };

  const finish = () => {
    ctx.run(async () => {
      if (draft.relay.mode === 'remote') {
        // Empty is meaningful: it is how you join a public relay.
        setRelayPassword(password);
      }
      saveDraft(draft);
      ctx.reloadConfig();
      const finalConfig = loadConfig();

      // Keep-alive first, deliberately. Installing it starts the services
      // through the service manager, so starting them here beforehand would
      // leave a second, detached copy holding the relay port and a second host
      // connector fighting the first for the same host id — which browsers see
      // as an endless reconnect loop. `startAll` defers to the manager once it
      // is installed, so the two options can no longer both spawn.
      let keepaliveInstalled = false;
      if (installKeepalive) {
        try {
          keepalive.install(finalConfig);
          keepaliveInstalled = true;
        } catch (error) {
          // Keep-alive is a convenience; a container without systemd should not
          // block a working setup.
          ctx.notify(t('keepalive.failed', { message: (error as Error).message }), 'error');
        }
      }
      if (startNow && !keepaliveInstalled) startAll(finalConfig);
      onDone();
    });
  };

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{t('wizard.title')}</Text>
      <Text color={theme.muted}>{t('wizard.step', { current: stepIndex + 1, total: steps.length })}</Text>
    </Box>
  );

  if (step === 'language') {
    return (
      <Panel title={t('wizard.languageTitle')}>
        {header}
        <ChoiceList
          options={[
            { id: 'auto', label: t('about.languageAuto', { detected: ctx.locale }) },
            { id: 'zh', label: t('about.languageZh') },
            { id: 'en', label: t('about.languageEn') },
          ]}
          current={draft.ui.language}
          onPick={(language) => { if (apply('language', language)) advance('language'); }}
          onCancel={() => {}}
        />
        <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
      </Panel>
    );
  }

  if (step === 'access') {
    return (
      <Panel title={t('wizard.accessTitle')}>
        {header}
        <ChoiceList
          options={[
            ...['local', 'lan'].map((mode) => ({
              id: mode,
              label: t(`mode.${mode}`),
              description: t(`mode.${mode}.description`),
            })),
            // Offered ahead of the self-hosted option because it is the one
            // that needs no server. It is still a separate, explicit choice:
            // it routes the terminal through a relay this user does not own.
            {
              id: 'official',
              label: t('mode.official'),
              description: t('mode.official.description'),
            },
            {
              id: 'remote',
              label: t('mode.remote'),
              description: t('mode.remote.description'),
            },
          ]}
          current={draft.relay.mode === 'remote' && draft.relay.remoteUrl === OFFICIAL_RELAY_URL
            ? 'official'
            : draft.relay.mode}
          onPick={(choice) => {
            if (choice === 'official') {
              // The official relay is "remote" with the address already known,
              // so the URL question is answered and skipped. It is a public
              // relay, so there is no join password to ask for either.
              if (!apply('mode', 'remote')) return;
              if (!apply('remoteUrl', OFFICIAL_RELAY_URL)) return;
              setRelayPassword('');
              advance('access', ['language', 'access', 'finish']);
              return;
            }
            if (apply('mode', choice)) advance('access', stepsFor(choice as AccessMode));
          }}
          onCancel={back}
        />
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('wizard.accessHint')}</Text>
        </Box>
        <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
      </Panel>
    );
  }

  if (step === 'address') {
    return (
      <Panel title={t('wizard.addressTitle')}>
        {header}
        {addresses.length === 0 ? (
          <Box flexDirection="column">
            <Text color={theme.warn}>{t('relay.noAddresses')}</Text>
            <Box marginTop={1}>
              <Selectable selected onSelect={() => advance('address')}>{t('wizard.finish')}</Selectable>
            </Box>
            <SkipKey onSkip={() => advance('address')} onBack={back} />
          </Box>
        ) : (
          <ChoiceList
            options={addresses.map((address) => ({
              id: address.address,
              label: `${address.address}  (${address.name}, ${address.kind})`,
            }))}
            current={draft.relay.lanHost || addresses[0].address}
            onPick={(address) => { if (apply('lanHost', address)) advance('address'); }}
            onCancel={back}
          />
        )}
        <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
      </Panel>
    );
  }

  if (step === 'relayUrl') {
    return (
      <Panel title={t('wizard.relayTitle')}>
        {header}
        <FieldRow label={t('wizard.relayUrlLabel')} selected onSelect={() => {}}>
          <TextField
            value={draft.relay.remoteUrl}
            placeholder="wss://relay.example.com"
            active
            onSubmit={(value) => {
              if (!value) { ctx.notify(t('error.remoteUrlRequired'), 'error'); return; }
              if (apply('remoteUrl', value)) advance('relayUrl');
            }}
            onCancel={back}
          />
        </FieldRow>
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('wizard.relayHint')}</Text>
        </Box>
        <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
      </Panel>
    );
  }

  if (step === 'password') {
    return (
      <Panel title={t('wizard.passwordTitle')}>
        {header}
        <FieldRow label={t('relay.password')} selected onSelect={() => {}}>
          <TextField
            value={password}
            placeholder={t('relay.passwordEmpty')}
            active
            mask
            onSubmit={(value) => { setPassword(value); advance('password'); }}
            onCancel={back}
          />
        </FieldRow>
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('wizard.passwordHint')}</Text>
        </Box>
        <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
      </Panel>
    );
  }

  const finishItems = [
    { id: 'startNow', label: `${t('wizard.startNow')}  [${startNow ? '×' : ' '}]` },
    { id: 'installKeepalive', label: `${t('wizard.installKeepalive')}  [${installKeepalive ? '×' : ' '}]` },
    { id: 'finish', label: t('wizard.finish') },
  ];

  const activateFinish = (id: string) => {
    if (id === 'startNow') { setStartNow((value) => !value); return; }
    if (id === 'installKeepalive') { setInstallKeepalive((value) => !value); return; }
    finish();
  };

  return (
    <Panel title={t('wizard.finishTitle')}>
      {header}
      <FinishKeys
        items={finishItems.map((item) => item.id)}
        selected={finishSelection}
        onSelect={setFinishSelection}
        onActivate={activateFinish}
        onBack={back}
      />
      {finishItems.map((item) => (
        <Selectable
          key={item.id}
          selected={finishSelection === item.id}
          onSelect={() => { setFinishSelection(item.id); activateFinish(item.id); }}
          onHover={() => setFinishSelection(item.id)}
        >
          {item.label}
        </Selectable>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>{t('wizard.finishHint', { path: configPath() })}</Text>
      </Box>
      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}

function FinishKeys({
  items,
  selected,
  onSelect,
  onActivate,
  onBack,
}: {
  items: string[];
  selected: string;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    const index = Math.max(0, items.indexOf(selected));
    if (key.escape) onBack();
    else if (key.upArrow) onSelect(items[(index - 1 + items.length) % items.length]);
    else if (key.downArrow) onSelect(items[(index + 1) % items.length]);
    else if (key.return) onActivate(selected);
  });
  return null;
}

function SkipKey({ onSkip, onBack }: { onSkip: () => void; onBack: () => void }) {
  useInput((_input, key) => {
    if (key.return) onSkip();
    else if (key.escape) onBack();
  });
  return null;
}
