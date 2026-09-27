import type React from 'react';
import { useEffect, useState } from 'react';
import { WS_CLIENT_PATH } from '@protocol/messages';
import { useSettings, useToasts } from '@/context/TerminalContext';
import { Button, FieldLabel, Input, Modal } from '@/shared/ui';
import { AdvancedFields } from './AdvancedFields';

interface AddHostModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Adds another Herdr instance to this browser.
 *
 * A pairing code is the whole of it: the relay serving this page knows which
 * workstation issued the code, and the instance names itself after that
 * workstation once it connects. Another relay or an existing device token are
 * the exceptions, so they wait behind the fold. Nothing here belongs to the
 * instance already open — its status, its client ID or a button that
 * disconnects it would only suggest the two share settings.
 */
export const AddHostModal: React.FC<AddHostModalProps> = ({ isOpen, onClose }) => {
  const { t, addProfileAndConnect } = useSettings();
  const { addToast } = useToasts();
  const [pairCode, setPairCode] = useState('');
  const [wsUrl, setWsUrl] = useState(WS_CLIENT_PATH);
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setPairCode('');
    setWsUrl(WS_CLIENT_PATH);
    setToken('');
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = pairCode.trim().toUpperCase();
    if (!code && !token.trim()) {
      addToast('warning', t('pairing.credentialsRequired'));
      return;
    }
    addProfileAndConnect({
      wsUrl: wsUrl.trim() || WS_CLIENT_PATH,
      pairCode: code,
      token: token.trim(),
    });
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('pairing.addTitle')}
      subtitle={t('pairing.addSubtitle')}
      closeLabel={t('common.closeDialog')}
      size="sm"
      hints={[
        { keys: 'esc', action: t('common.close') },
        { keys: '⏎', action: t('pairing.pairAndConnect') },
      ]}
      footer={
        <Button variant="primary" type="submit" form="add-host-form">
          {t('pairing.pairAndConnect')}
        </Button>
      }
    >
      <form id="add-host-form" onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <FieldLabel htmlFor="add-host-code" hint={t('pairing.pairCodeNote')}>
            {t('pairing.pairCodeLabel')}
          </FieldLabel>
          <Input
            id="add-host-code"
            type="text"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value.toUpperCase())}
            placeholder={t('pairing.pairCodePlaceholder')}
            maxLength={12}
            autoComplete="off"
            autoFocus
            className="font-bold uppercase"
          />
          <p className="text-tui-sm text-tui-faint">{t('pairing.pairCodeHelp')}</p>
        </div>

        <AdvancedFields hint={t('pairing.advancedHint')}>
          <div className="space-y-1">
            <FieldLabel htmlFor="add-host-ws">{t('pairing.wsUrlLabel')}</FieldLabel>
            <Input
              id="add-host-ws"
              type="text"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder={t('onboarding.wsEndpointPlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor="add-host-token" hint={t('pairing.tokenNote')}>
              {t('pairing.tokenLabel')}
            </FieldLabel>
            <Input
              id="add-host-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('onboarding.manualTokenPlaceholder')}
            />
          </div>
        </AdvancedFields>
      </form>
    </Modal>
  );
};
