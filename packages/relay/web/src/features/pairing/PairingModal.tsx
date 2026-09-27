import type React from 'react';
import { useState, useEffect } from 'react';
import { useSettings, useConnection, useToasts } from '@/context/TerminalContext';
import { describeConnection } from '@/connection/connectionStatus';
import { Button, Checkbox, FieldLabel, Input, Modal, StatusDot } from '@/shared/ui';
import { WS_CLIENT_PATH } from '@protocol/messages';
import { AdvancedFields } from './AdvancedFields';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The open instance's connection: its name, a new pairing code when it has to
 * pair again, and the rarely touched relay endpoint, token, client ID and
 * reconnect policy folded away below them.
 */
export const PairingModal: React.FC<PairingModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSettings, t, activeProfile, activeProfileId, renameProfile } =
    useSettings();
  const { connect, disconnect, connectionState, hostId } = useConnection();
  const { addToast } = useToasts();

  const [wsUrl, setWsUrl] = useState(settings.wsUrl);
  const [token, setToken] = useState(settings.token);
  const [pairCode, setPairCode] = useState(settings.pairCode);
  const [clientId, setClientId] = useState(settings.clientId);
  const [displayName, setDisplayName] = useState(activeProfile?.displayName || '');
  const [autoReconnect, setAutoReconnect] = useState(settings.autoReconnect);

  useEffect(() => {
    if (isOpen) {
      setWsUrl(settings.wsUrl);
      setToken(settings.token);
      setPairCode(settings.pairCode);
      setClientId(settings.clientId);
      setDisplayName(activeProfile?.displayName || '');
      setAutoReconnect(settings.autoReconnect);
    }
  }, [isOpen, settings, activeProfile]);

  if (!isOpen) return null;

  const handleSaveAndConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const connection = {
      wsUrl: wsUrl.trim() || WS_CLIENT_PATH,
      token: token.trim(),
      pairCode: pairCode.trim().toUpperCase(),
      clientId: clientId.trim() || settings.clientId,
      autoReconnect,
    };
    if (!connection.token && !connection.pairCode) {
      addToast('warning', t('pairing.credentialsRequired'));
      return;
    }
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
    onClose();
  };

  const status = describeConnection(connectionState, t);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('pairing.title')}
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
      <div className="mb-3 flex min-w-0 items-center gap-1.5 border-b border-tui-border-dim pb-2 text-tui">
        <StatusDot level={status.level} />
        <span className="shrink-0 text-tui-text">{status.label}</span>
        {hostId && <span className="truncate text-tui-muted">· {hostId}</span>}
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
        </div>

        <div className="space-y-1">
          <FieldLabel htmlFor="pairing-code" hint={t('pairing.repairNote')}>
            {t('pairing.pairCodeLabel')}
          </FieldLabel>
          <Input
            id="pairing-code"
            type="text"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value.toUpperCase())}
            placeholder={t('pairing.pairCodePlaceholder')}
            maxLength={12}
            autoComplete="off"
            className="uppercase"
          />
        </div>

        <AdvancedFields hint={t('pairing.editAdvancedHint')}>
          <div className="space-y-1">
            <FieldLabel htmlFor="pairing-ws">{t('pairing.wsUrlLabel')}</FieldLabel>
            <Input
              id="pairing-ws"
              type="text"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder={t('pairing.wsUrlPlaceholder')}
            />
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
                onClick={() => setClientId(`client-${Math.random().toString(36).substring(2, 8)}`)}
                className="shrink-0"
              >
                {t('pairing.newIdButton')}
              </Button>
            </div>
          </div>

          <Checkbox
            checked={autoReconnect}
            onChange={setAutoReconnect}
            label={t('pairing.autoReconnectLabel')}
          />
        </AdvancedFields>
      </form>
    </Modal>
  );
};
