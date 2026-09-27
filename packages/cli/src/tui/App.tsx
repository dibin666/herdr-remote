import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, type DOMElement } from 'ink';
import { useMouse, useMouseTarget } from './mouse/index.js';
import { theme } from './theme.js';
import {
  checkForRelayUpdate,
  checkForUpdate,
  createDraft,
  createTranslator,
  detectLocale,
  ensureRuntime,
  fullStatus,
  loadConfig,
  requiresRestart,
  runsLocalRelay,
  type Config,
  type Locale,
  type Status,
  type RelayUpdateCheck,
  type Translate,
  type UpdateCheck,
  updateChecksEnabled,
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

/**
 * A notice, as text in no particular language (an error from the system) or
 * as a way to say it in whichever language the interface is in when drawn:
 * switching language re-says what is already on screen.
 */
export type Notice = string | ((t: Translate) => string);

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
  notify: (notice: Notice, level?: MessageLevel) => void;
  run: (task: () => unknown | Promise<unknown>) => void;
  refresh: () => void;
  message: { text: string; level: MessageLevel } | null;
  /** The newest-release check made when the TUI opened; null until it answers. */
  updateCheck: UpdateCheck | null;
  setUpdateCheck: (next: UpdateCheck | null) => void;
  /** The same for the relay, asked only when this machine runs its own. */
  relayUpdateCheck: RelayUpdateCheck | null;
  setRelayUpdateCheck: (next: RelayUpdateCheck | null) => void;
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

function Tab({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
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

type UpdateChecker = () => Promise<UpdateCheck>;
type RelayUpdateChecker = () => Promise<RelayUpdateCheck>;

export function App({
  initialLanguage,
  needsWizard,
  updateChecker = updateChecksEnabled() ? (checkForUpdate as UpdateChecker) : null,
  relayUpdateChecker = updateChecksEnabled() ? (checkForRelayUpdate as RelayUpdateChecker) : null,
}: {
  initialLanguage: string | null;
  needsWizard: boolean;
  /** Asked once when the TUI opens; null turns the check off. */
  updateChecker?: UpdateChecker | null;
  /** Asked once when the TUI opens, if this machine runs its own relay. */
  relayUpdateChecker?: RelayUpdateChecker | null;
}) {
  const { exit } = useApp();
  const mouse = useMouse();

  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [draft, setDraft] = useState<Config>(() => createDraft());
  const [runtime, setRuntime] = useState(() => ensureRuntime());
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [notice, setNotice] = useState<{ notice: Notice; level: MessageLevel } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wizardDone, setWizardDone] = useState(!needsWizard);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [relayUpdateCheck, setRelayUpdateCheck] = useState<RelayUpdateCheck | null>(null);
  const localRelay = runsLocalRelay(config);

  // Every time the TUI opens: that is when someone is here to act on it.
  // Failure says nothing; the About tab can still be asked by hand.
  useEffect(() => {
    if (!updateChecker) return undefined;
    let cancelled = false;
    updateChecker()
      .then((result) => {
        if (!cancelled && result?.ok) setUpdateCheck(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [updateChecker]);

  // A relay somewhere else is somebody else's to update.
  useEffect(() => {
    if (!relayUpdateChecker || !localRelay) return undefined;
    let cancelled = false;
    relayUpdateChecker()
      .then((result) => {
        if (!cancelled && result?.ok) setRelayUpdateCheck(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [relayUpdateChecker, localRelay]);

  const locale: Locale = useMemo(
    () => detectLocale({ preference: initialLanguage ?? draft.ui.language }),
    [initialLanguage, draft.ui.language],
  );
  const t: Translate = useMemo(() => createTranslator(locale), [locale]);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(draft), [config, draft]);
  const restartPending = useMemo(
    () => dirty && requiresRestart(config, draft),
    [config, draft, dirty],
  );

  const notify = useCallback((next: Notice, level: MessageLevel = 'info') => {
    setNotice({ notice: next, level });
  }, []);
  const message = notice && {
    text: typeof notice.notice === 'string' ? notice.notice : notice.notice(t),
    level: notice.level,
  };

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
  const run = useCallback(
    (task: () => unknown | Promise<unknown>) => {
      setBusy(true);
      Promise.resolve()
        .then(task)
        .catch((error: Error) => notify(error.message, 'error'))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [notify, refresh],
  );

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
    updateCheck,
    setUpdateCheck,
    relayUpdateCheck,
    setRelayUpdateCheck,
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }
      if (input === 'q') {
        exit();
        return;
      }
      if (input === 'r') {
        setNotice(null);
        refresh();
        return;
      }
      if (input === 'm') {
        if (!mouse.supported) {
          notify((t) => t('hint.mouseUnsupported'), 'info');
          return;
        }
        mouseChoice.current = !mouse.enabled;
        if (mouse.enabled) mouse.disable();
        else mouse.enable();
        return;
      }
      const index = TABS.findIndex((entry) => entry.id === tab);
      if (key.rightArrow || (key.tab && !key.shift)) {
        setTab(TABS[(index + 1) % TABS.length].id);
        return;
      }
      if (key.leftArrow || (key.tab && key.shift)) {
        setTab(TABS[(index - 1 + TABS.length) % TABS.length].id);
        return;
      }
      const digit = Number.parseInt(input, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= TABS.length) setTab(TABS[digit - 1].id);
    },
    { isActive: wizardDone && editingId === null },
  );

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
    mouse.supported
      ? mouse.enabled
        ? t('hint.mouseOn')
        : t('hint.mouseOff')
      : t('hint.mouseUnsupported'),
    t('hint.quit'),
  ].filter(Boolean) as string[];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text bold>{t('app.name')}</Text>
          <Text color={theme.muted}>{`  ${t('app.tagline')}`}</Text>
        </Box>
        {updateCheck?.updateAvailable ? (
          <Text color={theme.warn}>
            {t('update.banner', { latest: updateCheck.latest ?? '', current: updateCheck.current })}
          </Text>
        ) : null}
        {localRelay && relayUpdateCheck?.updateAvailable ? (
          <Text color={theme.warn}>
            {t('relayUpdate.banner', {
              latest: relayUpdateCheck.latest ?? '',
              current: relayUpdateCheck.current,
            })}
          </Text>
        ) : null}
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
