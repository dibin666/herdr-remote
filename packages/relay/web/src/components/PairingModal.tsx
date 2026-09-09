import React, { useState, useEffect } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { describeConnection } from '../utils/connectionStatus';
import { copyText } from '../utils/clipboard';
import {
  Button,
  Checkbox,
  FieldLabel,
  GLYPH,
  Input,
  Modal,
  StatusDot,
  StatusLevel,
} from './tui';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opened from the profile switcher to create a new saved connection. */
  isAddMode?: boolean;
}

const STATE_TONE: Record<string, StatusLevel> = {
  connected: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  error: 'bad',
  disconnected: 'idle',
};

/**
 * Where the session's credentials live.
 *
 * Laid out as a TUI settings screen: a label column, one field per row, a
 * bracketed checkbox for the boolean, and the actions on the status line at the
 * bottom where a terminal program keeps them.
 */
export const PairingModal: React.FC<PairingModalProps> = ({ isOpen, onClose, isAddMode = false }) => {
  const {
    settings,
    updateSettings,
    connect,
    disconnect,
    connectionState,
    hostId,
    addToast,
    t,
    activeProfile,
    activeProfileId,
    addProfileAndConnect,
    renameProfile,
  } = useTerminal();

  const [wsUrl, setWsUrl] = useState(settings.wsUrl);
  const [token, setToken] = useState(settings.token);
  const [pairCode, setPairCode] = useState(settings.pairCode);
  const [clientId, setClientId] = useState(settings.clientId);
  const [displayName, setDisplayName] = useState(activeProfile?.displayName || '');
  const [autoReconnect, setAutoReconnect] = useState(settings.autoReconnect);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setWsUrl(settings.wsUrl);
      setToken(isAddMode ? '' : settings.token);
      setPairCode(isAddMode ? '' : settings.pairCode);
      setClientId(settings.clientId);
      setDisplayName(isAddMode ? '' : activeProfile?.displayName || '');
      setAutoReconnect(settings.autoReconnect);
    }
  }, [isOpen, isAddMode, settings, activeProfile]);

  if (!isOpen) return null;

  const handleSaveAndConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const connection = {
      wsUrl: wsUrl.trim() || '/ws/client',
      token: token.trim(),
      pairCode: pairCode.trim().toUpperCase(),
      clientId: clientId.trim() || settings.clientId,
      autoReconnect,
    };
    if (!connection.token && !connection.pairCode) {
      addToast('warning', t('pairing.credentialsRequired'));
      return;
    }
    if (isAddMode) {
      addProfileAndConnect({
        ...connection,
        displayName: displayName.trim() || undefined,
      });
    } else {
      updateSettings(connection);
      if (activeProfileId && displayName.trim()) renameProfile(activeProfileId, displayName);
      // `disconnect` clears the adapter's handlers synchronously, so the new
      // connection can start immediately without a close-event race or timer.
      disconnect();
      connect({
        wsUrl: connection.wsUrl,
        token: connection.token || undefined,
        pairCode: connection.pairCode || undefined,
        clientId: connection.clientId,
        autoReconnect,
      });
    }
    onClose();
  };

  const handleGenerateClientId = () => {
    const newId = `client-${Math.random().toString(36).substring(2, 8)}`;
    setClientId(newId);
  };

  const handleCopyShareUrl = () => {
    const url = new URL(window.location.href);
    url.search = '';
    if (pairCode.trim()) {
      url.searchParams.set('pairCode', pairCode.trim().toUpperCase());
    }
    // NEVER include long-lived tokens in share URL
    copyText(url.toString()).then((res) => {
      if (res === 'failed') {
        addToast('error', t('clipboard.copyFailed'));
        return;
      }
      setCopiedLink(true);
      addToast('success', t('toasts.pairingLinkCopied'));
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  const tone = STATE_TONE[connectionState] ?? 'idle';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isAddMode ? t('pairing.addTitle') : t('pairing.title')}
      subtitle={t('pairing.subtitle')}
      closeLabel={t('common.closeDialog')}
      hints={[
        { keys: 'esc', action: t('common.close') },
        { keys: '⏎', action: t('pairing.saveAndConnect') },
      ]}
      footer={
        <>
          {connectionState === 'connected' && (
            <Button
              variant="danger"
              onClick={() => {
                disconnect();
                onClose();
              }}
            >
              {t('common.disconnect')}
            </Button>
          )}
          <Button variant="primary" type="submit" form="pairing-form">
            {t('pairing.saveAndConnect')}
          </Button>
        </>
      }
    >
      {/* Live session state, on one line, the way a TUI reports itself. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-tui-border-dim pb-2 text-tui">
        <span className="flex items-center gap-1.5">
          <StatusDot level={tone} />
          <span className="text-tui-muted">{t('common.status')}</span>
          {/* The state in the interface's own words. Printing the protocol's
              own enum here left `CONNECTED` sitting in the middle of a Chinese
              sentence. */}
          <span
            className={cn(
              tone === 'ok'
                ? 'text-tui-ok'
                : tone === 'bad'
                  ? 'text-tui-bad'
                  : tone === 'warn'
                    ? 'text-tui-warn'
                    : 'text-tui-faint'
            )}
          >
            {describeConnection(connectionState, t).label}
          </span>
        </span>
        {hostId && (
          <span className="flex items-center gap-1.5 text-tui-muted">
            {t('common.host')} <span className="text-tui-text">{hostId}</span>
          </span>
        )}
      </div>

      <form id="pairing-form" onSubmit={handleSaveAndConnect} className="space-y-3">
        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-name">{t('pairing.displayNameLabel')}</FieldLabel>
          <Input
            id="pairing-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('pairing.displayNamePlaceholder')}
            maxLength={64}
            autoComplete="off"
          />
          <p className="text-tui-sm text-tui-faint">{t('pairing.displayNameHelp')}</p>
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-code" hint={t('pairing.pairCodeNote')}>
            {t('pairing.pairCodeLabel')}
          </FieldLabel>
          <Input
            id="pairing-code"
            type="text"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value.toUpperCase())}
            placeholder={t('pairing.pairCodePlaceholder')}
            maxLength={12}
            className="uppercase"
          />
          <p className="text-tui-sm text-tui-faint">{t('pairing.pairCodeHelp')}</p>
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-token" hint={t('pairing.tokenNote')}>
            {t('pairing.tokenLabel')}
          </FieldLabel>
          <Input
            id="pairing-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('pairing.tokenPlaceholder')}
          />
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-ws">{t('pairing.wsUrlLabel')}</FieldLabel>
          <Input
            id="pairing-ws"
            type="text"
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            placeholder={t('pairing.wsUrlPlaceholder')}
          />
          <p className="text-tui-sm text-tui-faint">{t('pairing.wsUrlDefaultNote')}</p>
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-client-id">{t('pairing.clientIdLabel')}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="pairing-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="flex-1"
            />
            <Button
              onClick={handleGenerateClientId}
              title={t('pairing.regenerateClientIdTitle')}
              className="shrink-0"
            >
              {t('pairing.newIdButton')}
            </Button>
          </div>
        </div>

        <div className="border-t border-tui-border-dim pt-2">
          <Checkbox
            checked={autoReconnect}
            onChange={setAutoReconnect}
            label={t('pairing.autoReconnectLabel')}
            description={t('pairing.autoReconnectDesc')}
          />
        </div>

        <div className="border-t border-tui-border-dim pt-2">
          <Button
            onClick={handleCopyShareUrl}
            block
            glyph={copiedLink ? GLYPH.check : '⧉'}
            className={cn(copiedLink && 'border-tui-ok text-tui-ok')}
          >
            {t('pairing.copyDirectLink')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
