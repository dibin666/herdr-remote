import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { FieldRow, Menu, Message, Panel, Row, Selectable } from '../components/common.js';
import { TextField } from '../components/TextField.js';
import {
  OFFICIAL_RELAY_URL,
  bindAddress,
  fieldsForMode,
  getField,
  getFieldPlaceholder,
  listReachableAddresses,
  probeRelay,
  regenerateHostIdentity,
  relayStartCommand,
  saveDraft,
  setField,
  setRelayPassword,
  type NetworkAddress,
} from '../api.js';

type Entry = { id: string; kind: 'field' | 'password' | 'action'; label: string; fieldKind?: string };

export function RelayScreen({ ctx }: { ctx: AppContext }) {
  const { t, draft, editingId } = ctx;
  const [selected, setSelected] = useState('mode');
  const [revealTokens, setRevealTokens] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [password, setPassword] = useState<string>(ctx.runtime.relayPassword || '');

  const fields = useMemo(() => fieldsForMode(draft.relay.mode)
    .filter((field: { id: string }) => ['mode', 'port', 'lanHost', 'remoteUrl', 'publicUrl'].includes(field.id)),
  [draft.relay.mode]);

  const entries: Entry[] = [
    ...fields.map((field: { id: string; kind: string; labelKey: string }) => ({
      id: field.id,
      kind: 'field' as const,
      fieldKind: field.kind,
      label: t(field.labelKey),
    })),
    // The password only matters when talking to a relay somebody else started;
    // a local relay is configured with our own token automatically.
    ...(draft.relay.mode === 'remote'
      ? [{ id: 'password', kind: 'password' as const, label: t('relay.password') }]
      : []),
    // Saving needs a row of its own. Every field here only edits a draft, and
    // the services restart from what is on disk — with `s` as the sole way to
    // commit, a change could look applied, survive a restart, and never take
    // effect. It is also the only way to save with the mouse.
    { id: 'save', kind: 'action' as const, label: t('common.save') },
    { id: 'test', kind: 'action' as const, label: t('relay.test') },
    ...(draft.relay.mode === 'remote'
      ? [
        { id: 'reveal', kind: 'action' as const, label: revealTokens ? t('relay.hidePassword') : t('relay.showPassword') },
        { id: 'env', kind: 'action' as const, label: t('relay.envSnippet') },
      ]
      : []),
    { id: 'regenerate', kind: 'action' as const, label: t('relay.regenerate') },
  ];

  const addresses: NetworkAddress[] = useMemo(() => listReachableAddresses({ includeLoopback: false }), []);

  /**
   * Apply several fields as one edit.
   *
   * Each `setField` has to build on the previous result rather than on `draft`,
   * which is the value captured when this render began. Calling a single-field
   * helper twice in a row silently dropped the first change: the second call
   * started from the stale draft and committed it back over the first.
   */
  const applyFields = (updates: Array<[string, string]>) => {
    let next = draft;
    for (const [id, value] of updates) {
      const result = setField(next, id, value);
      if (result.errorKey) {
        ctx.notify(t(result.errorKey), 'error');
        return false;
      }
      next = result.draft;
    }
    ctx.updateDraft(next);
    ctx.notify('', 'info');
    return true;
  };

  const applyField = (id: string, value: string) => applyFields([[id, value]]);

  const save = () => {
    try {
      const result = saveDraft(draft);
      ctx.reloadConfig();
      ctx.notify(t('common.saved', { path: result.path }), 'success');
    } catch (error) {
      const problems = (error as Error & { problems?: string[] }).problems;
      ctx.notify(problems ? problems.map((key) => t(key)).join(' ') : t('error.saveFailed', { message: (error as Error).message }), 'error');
    }
  };

  const activate = (id: string) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (entry.kind === 'field' || entry.kind === 'password') {
      ctx.setEditing(id);
      return;
    }
    if (id === 'save') { save(); return; }
    if (id === 'reveal') { setRevealTokens((current) => !current); return; }
    if (id === 'env') { setShowEnv((current) => !current); return; }
    if (id === 'regenerate') {
      ctx.run(() => {
        regenerateHostIdentity();
        ctx.reloadConfig();
        ctx.notify(t('relay.regenerated'), 'success');
      });
      return;
    }
    if (id === 'test') {
      ctx.run(async () => {
        const result = await probeRelay(ctx.config);
        ctx.notify(
          result.ok
            ? t('relay.testOk', { version: result.version ?? '?', hosts: result.hosts ?? 0 })
            : t('relay.testFailed', { message: result.message ?? '' }),
          result.ok ? 'success' : 'error',
        );
      });
    }
  };

  useInput((input, key) => {
    const index = entries.findIndex((entry) => entry.id === selected);
    if (key.upArrow) setSelected(entries[(index - 1 + entries.length) % entries.length].id);
    else if (key.downArrow) setSelected(entries[(index + 1) % entries.length].id);
    else if (key.return) activate(selected);
    else if (input === 's') save();
  }, { isActive: editingId === null });

  // Choice editors take over the panel so the option list is unambiguous.
  if (editingId === 'mode') {
    return (
      <Panel title={t('field.mode')}>
        <ChoiceList
          options={[
            ...['local', 'lan'].map((mode) => ({
              id: mode,
              label: t(`mode.${mode}`),
              description: t(`mode.${mode}.description`),
            })),
            { id: 'official', label: t('mode.official'), description: t('mode.official.description') },
            { id: 'remote', label: t('mode.remote'), description: t('mode.remote.description') },
          ]}
          // Reflects the official relay as its own selection rather than as an
          // indistinguishable "self-hosted" row that happens to hold our URL.
          current={draft.relay.mode === 'remote' && draft.relay.remoteUrl === OFFICIAL_RELAY_URL
            ? 'official'
            : draft.relay.mode}
          onPick={(choice) => {
            if (choice === 'official') {
              // Fills in the address the same way the first-run wizard does, so
              // switching over here needs no second trip to the URL field. Both
              // fields move together — a mode with no URL is not a valid state.
              applyFields([['mode', 'remote'], ['remoteUrl', OFFICIAL_RELAY_URL]]);
              ctx.setEditing(null);
              return;
            }
            applyField('mode', choice);
            ctx.setEditing(null);
          }}
          onCancel={() => ctx.setEditing(null)}
        />
      </Panel>
    );
  }

  if (editingId === 'lanHost') {
    const options = addresses.map((address) => ({
      id: address.address,
      label: `${address.address}  (${address.name}, ${t(addressKindKey(address.kind))})`,
    }));
    return (
      <Panel title={t('relay.selectAddress')}>
        {options.length === 0 ? (
          <Text color={theme.warn}>{t('relay.noAddresses')}</Text>
        ) : (
          <ChoiceList
            options={options}
            current={draft.relay.lanHost || options[0].id}
            onPick={(address) => { applyField('lanHost', address); ctx.setEditing(null); }}
            onCancel={() => ctx.setEditing(null)}
          />
        )}
      </Panel>
    );
  }

  return (
    <Panel title={t('relay.title')}>
      {draft.relay.mode !== 'remote' ? (
        <Box flexDirection="column" marginBottom={1}>
          <Row label={t('relay.listenAddress')}>
            <Text color={theme.muted}>{`${bindAddress(draft)}:${draft.relay.port}`}</Text>
          </Row>
          <Text color={theme.muted}>{t('relay.listenAddressHint')}</Text>
        </Box>
      ) : null}

      {entries.map((entry) => (
        entry.kind === 'action' ? (
          <Selectable
            key={entry.id}
            selected={selected === entry.id}
            onSelect={() => { setSelected(entry.id); activate(entry.id); }}
            onHover={() => setSelected(entry.id)}
          >
            {entry.label}
          </Selectable>
        ) : (
          <FieldRow
            key={entry.id}
            label={entry.label}
            selected={selected === entry.id}
            onSelect={() => activate(entry.id)}
            onHover={() => setSelected(entry.id)}
          >
            {entry.kind === 'password' ? (
                <TextField
                  value={password}
                  placeholder={t('relay.passwordEmpty')}
                  active={editingId === 'password'}
                  mask={!revealTokens}
                  onSubmit={(value) => {
                    setPassword(value);
                    setRelayPassword(value);
                    ctx.setEditing(null);
                    ctx.notify(t('relay.passwordSaved'), 'success');
                  }}
                  onCancel={() => ctx.setEditing(null)}
                />
              ) : entry.fieldKind === 'choice' ? (
                // Choice fields are picked from a list, never typed, so they
                // show the translated label rather than the stored id.
                <Text>{t(`mode.${getField(draft, entry.id)}`)}</Text>
              ) : (
                <TextField
                  value={getField(draft, entry.id)}
                  placeholder={placeholderText(ctx, entry.id)}
                  active={editingId === entry.id}
                  onSubmit={(value) => { if (applyField(entry.id, value)) ctx.setEditing(null); }}
                onCancel={() => ctx.setEditing(null)}
              />
            )}
          </FieldRow>
        )
      ))}

      {ctx.dirty ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>{t('hint.unsavedChanges')}</Text>
        </Box>
      ) : null}

      {draft.relay.mode === 'remote' ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{t('relay.passwordHint')}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Row label={t('relay.identity')}>
          <Text color={theme.muted}>{ctx.runtime.hostId}</Text>
        </Row>
      </Box>

      {showEnv ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
          <Text color={theme.muted}>{t('relay.envHint')}</Text>
          <Text>{relayStartCommand(ctx.config, password)}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>{t('relay.docsHint')}</Text>
      </Box>

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}

function placeholderText(ctx: AppContext, id: string): string {
  const raw = getFieldPlaceholder(ctx.draft, id);
  // Placeholders that name a translation key are resolved here so the model
  // stays free of language concerns.
  return raw.startsWith('placeholder.') ? ctx.t(raw) : raw;
}

function addressKindKey(kind: NetworkAddress['kind']): string {
  return `relay.address${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

export type ChoiceOption = { id: string; label: string; description?: string };

/**
 * A modal list of options driven by both arrow keys and the mouse.
 *
 * It owns the cursor so the highlighted row and the keyboard agree; the parent
 * only learns which option was chosen.
 */
export function ChoiceList({
  options,
  current,
  onPick,
  onCancel,
}: {
  options: ChoiceOption[];
  current: string;
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const index = options.findIndex((option) => option.id === current);
    return index >= 0 ? index : 0;
  });
  const active = options[Math.min(cursor, options.length - 1)];

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) setCursor((value) => (value - 1 + options.length) % options.length);
    else if (key.downArrow) setCursor((value) => (value + 1) % options.length);
    else if (key.return && active) onPick(active.id);
  });

  return (
    <Box flexDirection="column">
      <Menu
        items={options.map((option) => ({ id: option.id, label: option.label }))}
        selectedId={active?.id ?? ''}
        onChange={(id) => setCursor(options.findIndex((option) => option.id === id))}
        onSelect={onPick}
      />
      {active?.description ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{active.description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
