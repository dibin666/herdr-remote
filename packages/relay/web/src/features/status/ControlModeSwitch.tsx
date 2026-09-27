import type React from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { Row, Segmented } from '@/shared/ui';

type ControlMode = 'control' | 'observe';

/**
 * Whether this window types into its terminal or only watches it.
 *
 * Every paired window has a terminal of its own with full input, so observing
 * is not a lease handed between windows: it is this window deciding to take no
 * stray tap or keystroke — a phone left beside the keyboard, a screen on the
 * wall. It still scrolls, which is what reading back through an agent's output
 * needs.
 */
export const ControlModeSwitch: React.FC<{ compact?: boolean; className?: string }> = ({
  compact = false,
  className,
}) => {
  const { settings, updateSettings, t } = useSettings();
  const { connectionState, sharedWindowCount, assignedClientId } = useConnection();
  const observing = settings.observerMode;

  const toggle = (
    <Segmented<ControlMode>
      name="control-mode"
      aria-label={t('role.modeLabel')}
      value={observing ? 'observe' : 'control'}
      onChange={(mode) => updateSettings({ observerMode: mode === 'observe' })}
      tone={observing ? 'warn' : 'ok'}
      size={compact ? 'sm' : 'md'}
      options={[
        { value: 'control', label: t('role.sharedControl') },
        { value: 'observe', label: t('common.viewer') },
      ]}
      className={className}
    />
  );

  if (compact) return toggle;

  return (
    <div className="flex w-full flex-col gap-1">
      {toggle}
      <p className="text-tui-sm leading-snug text-tui-faint">
        {observing ? t('role.observerHint') : t('role.controlHint')}
      </p>
      {connectionState === 'connected' && sharedWindowCount > 1 ? (
        <p className="text-tui-sm text-tui-muted">
          {t('role.sharedWindows', { count: sharedWindowCount })}
        </p>
      ) : null}
      {assignedClientId ? (
        <Row label={t('role.thisWindow')} labelWidth={9} className="text-tui-sm">
          <span className="truncate text-tui-muted">{assignedClientId}</span>
        </Row>
      ) : null}
    </div>
  );
};
