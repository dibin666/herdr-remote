import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import QRCode from 'qrcode';
import type { AppContext } from '../App.js';
import { theme } from '../theme.js';
import { Menu, Message, Panel } from '../components/common.js';
import { extractPairingCode, pair, type Pairing } from '../api.js';

// A QR block needs room for the symbol plus its quiet zone; below this the
// output wraps into noise, so the URL alone is the honest thing to show.
const MIN_QR_COLUMNS = 44;

export function PairScreen({ ctx }: { ctx: AppContext }) {
  const { t, run } = ctx;
  const { columns } = useWindowSize();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [selected, setSelected] = useState('generate');

  useEffect(() => {
    if (!pairing) return undefined;
    const tick = () => setRemainingMs(Math.max(0, pairing.expiresAt - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (!pairing || columns < MIN_QR_COLUMNS) { setQr(null); return; }
    let cancelled = false;
    QRCode.toString(pairing.pairUrl, { type: 'terminal', small: true, errorCorrectionLevel: 'L' })
      .then((value: string) => { if (!cancelled) setQr(value.replace(/\n$/, '')); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [pairing, columns]);

  const generate = () => run(async () => {
    ctx.notify(t('pair.working'));
    try {
      const result = await pair();
      const code = extractPairingCode(result);
      setPairing({ ...result, code });
      ctx.notify('', 'info');
    } catch (error) {
      const message = (error as Error).message;
      setPairing(null);
      throw new Error(/host_offline|no Herdr host|did not register/i.test(message)
        ? t('pair.hostOffline')
        : t('pair.failed', { message }));
    }
  });

  useInput((_input, key) => {
    if (key.return) generate();
  }, { isActive: ctx.editingId === null });

  const expired = pairing !== null && remainingMs <= 0;
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);

  return (
    <Panel title={t('pair.title')}>
      <Menu
        items={[{ id: 'generate', label: pairing ? t('pair.regenerate') : t('pair.generate') }]}
        selectedId={selected}
        onChange={setSelected}
        onSelect={generate}
      />

      {pairing ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={theme.muted}>{`${t('pair.code')}  `}</Text>
            <Text bold color={expired ? theme.muted : theme.accent}>
              {pairing.code.split('').join(' ')}
            </Text>
          </Box>
          <Box>
            <Text color={theme.muted}>{`${t('pair.url')}  `}</Text>
            <Text>{pairing.pairUrl}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={expired ? theme.bad : theme.muted}>
              {expired
                ? t('pair.expired')
                : t('pair.expires', {
                  minutes: `${minutes}:${String(seconds).padStart(2, '0')}`,
                  time: new Date(pairing.expiresAt).toLocaleTimeString(),
                })}
            </Text>
          </Box>

          {!expired && qr ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>{qr}</Text>
              <Text color={theme.muted}>{t('pair.qrHint')}</Text>
            </Box>
          ) : null}
          {!expired && !qr && columns < MIN_QR_COLUMNS ? (
            <Box marginTop={1}>
              <Text color={theme.muted}>{t('pair.qrUnavailable')}</Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={theme.muted}>{t('pair.instructions')}</Text>
          </Box>
        </Box>
      ) : null}

      <Message text={ctx.message?.text ?? null} level={ctx.message?.level ?? 'info'} />
    </Panel>
  );
}
