import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, type DOMElement } from 'ink';
import { useMouse, useMouseTarget } from './mouse/index.js';
import { theme } from './theme.js';
import {
  createDraft,
  createTranslator,
  detectLocale,
  ensureRuntime,
  fullStatus,
  loadConfig,
  requiresRestart,
  type Config,
  type Locale,
  type Status,
  type Translate,
} from './api.js';
import { Overview } from './screens/Overview.js';
import { PairScreen } from './screens/Pair.js';
import { Services } from './screens/Services.js';
import { RelayScreen } from './screens/Relay.js';
import { Keepalive } from './screens/Keepalive.js';
import { HerdrScreen } from './screens/Herdr.js';
import { About } from './screens/About.js';
import { Wizard } from './screens/Wizard.js';

const STATUS_POLL_MS = 3000;

export type MessageLevel = 'info' | 'success' | 'error';

export type AppContext = {
  t: Translate;
  locale: Locale;
  config: Config;
  draft: Config;
  status: Status | null;
  runtime: { hostId: string; hostToken: string; relayPassword?: string };
  busy: boolean;
  dirty: boolean;
  editingId: string | null;
  updateDraft: (next: Config) => void;
  reloadConfig: () => void;
  setEditing: (id: string | null) => void;
  notify: (text: string, level?: MessageLevel) => void;
  run: (task: () => unknown | Promise<unknown>) => void;
  refresh: () => void;
  message: { text: string; level: MessageLevel } | null;
};

type TabId = 'overview' | 'pair' | 'services' | 'relay' | 'keepalive' | 'herdr' | 'about';

const TABS: { id: TabId; labelKey: string }[] = [
  { id: 'overview', labelKey: 'nav.overview' },
  { id: 'pair', labelKey: 'nav.pair' },
  { id: 'services', labelKey: 'nav.services' },
  { id: 'relay', labelKey: 'nav.relay' },
  { id: 'keepalive', labelKey: 'nav.keepalive' },
  { id: 'herdr', labelKey: 'nav.herdr' },
  { id: 'about', labelKey: 'nav.about' },
];

function Tab({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  const ref = useRef<DOMElement>(null);
  const hovered = useMouseTarget(ref, { onClick: onSelect });
  return (
    <Box ref={ref} marginRight={2}>
      <Text
        color={active || hovered ? theme.accent : theme.muted}
        bold={active}
        underline={active || hovered}
      >
        {label}
      </Text>
    </Box>
  );
}

function Footer({ hints }: { hints: string[] }) {
  return (
    <Box marginTop={1} paddingX={1}>
      <Text color={theme.muted}>{hints.join('  ·  ')}</Text>
    </Box>
  );
}

export function App({ initialLanguage, needsWizard }: { initialLanguage: Locale | null; needsWizard: boolean }) {
  const { exit } = useApp();
  const mouse = useMouse();

  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [draft, setDraft] = useState<Config>(() => createDraft());
  const [runtime, setRuntime] = useState(() => ensureRuntime());
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [message, setMessage] = useState<{ text: string; level: MessageLevel } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wizardDone, setWizardDone] = useState(!needsWizard);

  const locale: Locale = useMemo(
    () => detectLocale({ preference: initialLanguage ?? draft.ui.language }),
    [initialLanguage, draft.ui.language],
  );
  const t: Translate = useMemo(() => createTranslator(locale), [locale]);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(draft), [config, draft]);
  const restartPending = useMemo(() => dirty && requiresRestart(config, draft), [config, draft, dirty]);

  const notify = useCallback((text: string, level: MessageLevel = 'info') => {
    setMessage({ text, level });
  }, []);

  const refresh = useCallback(() => {
    fullStatus(loadConfig())
      .then((next: Status) => setStatus(next))
      .catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);

  const reloadConfig = useCallback(() => {
    const next = loadConfig();
    setConfig(next);
    setDraft(createDraft(next));
    setRuntime(ensureRuntime());
  }, []);

  /**
   * Run an action with a busy flag and a single place to surface failures, so
   * no screen can leave the interface spinning or swallow an error.
   */
  const run = useCallback((task: () => unknown | Promise<unknown>) => {
    setBusy(true);
    Promise.resolve()
      .then(task)
      .catch((error: Error) => notify(error.message, 'error'))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  }, [notify, refresh]);

  useEffect(() => {
    if (!wizardDone) return undefined;
    refresh();
    const timer = setInterval(() => {
      if (!editingId) refresh();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [wizardDone, refresh, editingId]);

  // Mouse tracking starts on its own where the terminal supports it, and can be
  // switched off with `m` — while it is on, the terminal's own text selection is
  // disabled, which is exactly what you want back when copying a pairing URL
  // out of the pane. Once the user presses `m`, their choice is recorded and the
  // automatic enable stops interfering.
  const mouseChoice = useRef<boolean | null>(null);
  useEffect(() => {
    if (mouseChoice.current !== null) return;
    if (mouse.supported && !mouse.enabled) mouse.enable();
  }, [mouse.supported, mouse.enabled, mouse]);

  const context: AppContext = {
    t,
    locale,
    config,
    draft,
    status,
    runtime,
    busy,
    dirty,
    editingId,
    updateDraft: setDraft,
    reloadConfig,
    setEditing: setEditingId,
    notify,
    run,
    refresh,
    message,
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (input === 'q') { exit(); return; }
    if (input === 'r') { setMessage(null); refresh(); return; }
    if (input === 'm') {
      if (!mouse.supported) { notify(t('hint.mouseUnsupported'), 'info'); return; }
      mouseChoice.current = !mouse.enabled;
      if (mouse.enabled) mouse.disable(); else mouse.enable();
      return;
    }
    const index = TABS.findIndex((entry) => entry.id === tab);
    if (key.rightArrow || (key.tab && !key.shift)) { setTab(TABS[(index + 1) % TABS.length].id); return; }
    if (key.leftArrow || (key.tab && key.shift)) { setTab(TABS[(index - 1 + TABS.length) % TABS.length].id); return; }
    const digit = Number.parseInt(input, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= TABS.length) setTab(TABS[digit - 1].id);
  }, { isActive: wizardDone && editingId === null });

  if (!wizardDone) {
    return (
      <Wizard
        ctx={context}
        onDone={() => {
          reloadConfig();
          setWizardDone(true);
          refresh();
        }}
      />
    );
  }

  const hints = [
    t('hint.navigate'),
    t('hint.select'),
    t('hint.tabs'),
    dirty ? t('hint.save') : null,
    mouse.supported ? (mouse.enabled ? t('hint.mouseOn') : t('hint.mouseOff')) : t('hint.mouseUnsupported'),
    t('hint.quit'),
  ].filter(Boolean) as string[];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>{t('app.name')}</Text>
        <Text color={theme.muted}>{`  ${t('app.tagline')}`}</Text>
      </Box>

      <Box marginBottom={1}>
        {TABS.map((entry, entryIndex) => (
          <Tab
            key={entry.id}
            label={`${entryIndex + 1} ${t(entry.labelKey)}`}
            active={entry.id === tab}
            onSelect={() => setTab(entry.id)}
          />
        ))}
      </Box>

      {tab === 'overview' ? <Overview ctx={context} /> : null}
      {tab === 'pair' ? <PairScreen ctx={context} /> : null}
      {tab === 'services' ? <Services ctx={context} /> : null}
      {tab === 'relay' ? <RelayScreen ctx={context} /> : null}
      {tab === 'keepalive' ? <Keepalive ctx={context} /> : null}
      {tab === 'herdr' ? <HerdrScreen ctx={context} /> : null}
      {tab === 'about' ? <About ctx={context} /> : null}

      {restartPending ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>{t('hint.restartRequired')}</Text>
        </Box>
      ) : null}

      <Footer hints={hints} />
    </Box>
  );
}
