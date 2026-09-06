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
  selectedMode,
  setField,
  setRelayPassword,
  startAll,
  type AccessMode,
  type NetworkAddress,
} from '../api.js';

export type StepId = 'language' | 'access' | 'address' | 'relayUrl' | 'password' | 'finish';

/**
 * The questions worth asking for a given access mode, in order.
 *
 * `remoteUrl` matters because the official relay is a remote relay whose
 * address and credentials are already known, so it asks neither question. The
 * step counter is derived from this list, so it has to agree with the route
 * actually taken or the wizard reports "step 5 of 5" on its third screen.
 */
export function stepsFor(mode: AccessMode, remoteUrl?: string): StepId[] {
  const steps: StepId[] = ['language', 'access'];
  if (mode === 'lan') steps.push('address');
  if (mode === 'remote' && remoteUrl !== OFFICIAL_RELAY_URL) steps.push('relayUrl', 'password');
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

  const steps: StepId[] = useMemo(
    () => stepsFor(draft.relay.mode, draft.relay.remoteUrl),
    [draft.relay.mode, draft.relay.remoteUrl],
  );
  const stepIndex = Math.max(0, steps.indexOf(step));

  /**
   * Apply several fields as one edit. Each `setField` builds on the previous
   * result: `draft` is the value captured when this render began, so applying
   * two fields through two separate calls committed the second over the first.
   */
  const applyAll = (updates: Array<[string, string]>) => {
    let next = draft;
    for (const [id, value] of updates) {
      const result = setField(next, id, value);
      if (result.errorKey) { ctx.notify(t(result.errorKey), 'error'); return false; }
      next = result.draft;
    }
    ctx.updateDraft(next);
    ctx.notify('', 'info');
    return true;
  };

  const apply = (id: string, value: string) => applyAll([[id, value]]);

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
          current={selectedMode(draft)}
          onPick={(choice) => {
            if (choice === 'official') {
              // The official relay is "remote" with the address already known,
              // so the URL question is answered and skipped. It is a public
              // relay, so there is no join password to ask for either — and any
              // password left over from a previous self-hosted answer would
              // only be sent to a relay that does not want it.
              if (!apply('mode', 'official')) return;
              setRelayPassword('');
              advance('access', stepsFor('remote', OFFICIAL_RELAY_URL));
              return;
            }
            if (apply('mode', choice)) {
              // Leaving the official relay clears its address, so the URL step
              // that follows starts empty rather than pre-loaded with ours.
              advance('access', stepsFor(choice as AccessMode, choice === 'remote' ? '' : draft.relay.remoteUrl));
            }
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
