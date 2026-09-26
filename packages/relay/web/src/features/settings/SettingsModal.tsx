import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettings, useToasts } from '@/context/TerminalContext';
import type { AgentProfileId } from '@/features/agents/agentKeymaps';
import { getDefaultSettings } from './storage';
import { AgentKeymapsTab } from './AgentKeymapsTab';
import { GeneralTab } from './GeneralTab';
import { DANGER_GHOST } from './styles';
import { VirtualKeysTab } from './VirtualKeysTab';
import { Button, Modal, Tabs } from '@/shared/ui';

export type SettingsTab = 'general' | 'virtualKeys' | 'agentKeymaps';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open on this tab, showing the focused agent, instead of where it was left. */
  initialTab?: SettingsTab;
  /** Leave the dialog for the relay dashboard. */
  onOpenAdmin?: () => void;
}

/**
 * Preferences, as a TUI settings screen.
 *
 * Numbered tabs across the top; each tab is a stack of headed groups, and each
 * setting is one row with its words on the left and its control on the right.
 * Every control is the same width and height and every choice is drawn the
 * same way — cells with the chosen one filled — so the screen reads as one
 * column of answers rather than a page of mixed widgets. Colour is kept for
 * meaning: blue headings and choices, green for a switch that is on, red for
 * the words that reset something.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  initialTab,
  onOpenAdmin,
}) => {
  const { updateSettings, t } = useSettings();
  const { addToast } = useToasts();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [settingsAgentProfile, setSettingsAgentProfile] = useState<AgentProfileId | null>(null);

  useEffect(() => {
    if (!isOpen || !initialTab) return;
    setActiveTab(initialTab);
    setSettingsAgentProfile(null);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const handleResetDefaults = () => {
    const defaults = getDefaultSettings();
    updateSettings({
      fontSize: defaults.fontSize,
      fontSizeFollowsHost: defaults.fontSizeFollowsHost,
      fontFamily: defaults.fontFamily,
      toolbarVisible: defaults.toolbarVisible,
      vibrateOnKeyPress: defaults.vibrateOnKeyPress,
      predictiveEcho: defaults.predictiveEcho,
      agentAlertBadge: defaults.agentAlertBadge,
      agentAlertSound: defaults.agentAlertSound,
      agentAlertVibrate: defaults.agentAlertVibrate,
      agentAlertNotify: defaults.agentAlertNotify,
      language: defaults.language,
      virtualKeys: defaults.virtualKeys,
    });
    addToast('info', t('settings.resetDefaultsToast'));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      closeLabel={t('common.closeDialog')}
      size="lg"
      fixedHeight
      hints={[{ keys: 'esc', action: t('common.close') }]}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults} className={DANGER_GHOST}>
            {t('settings.resetDefaults')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'general', label: t('settings.tabGeneral'), index: 1 },
          { id: 'virtualKeys', label: t('settings.tabVirtualKeys'), index: 2 },
          { id: 'agentKeymaps', label: t('settings.tabAgentKeymaps'), index: 3 },
        ]}
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as SettingsTab)}
        className="mb-3 border-b border-tui-border-dim pb-1"
      />

      {activeTab === 'general' && <GeneralTab onOpenAdmin={onOpenAdmin} />}
      {activeTab === 'virtualKeys' && <VirtualKeysTab />}
      {activeTab === 'agentKeymaps' && (
        <AgentKeymapsTab profile={settingsAgentProfile} onProfileChange={setSettingsAgentProfile} />
      )}
    </Modal>
  );
};
