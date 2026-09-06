import React from 'react';
import { cn } from '../../utils/cn';
import { Meter, StatusLevel, TONE } from '../tui';

interface MetricGaugeProps {
  label: string;
  value: number; // 0 to 100
  displayValue: string;
  detail?: string;
  /** Colour while the reading is unremarkable; pressure overrides it. */
  tone?: StatusLevel;
}

/**
 * A utilisation reading, drawn as `████████░░░░` across the full width.
 *
 * The bar is real characters rather than a coloured div, so it belongs to the
 * same grid as the numbers beside it — and it stays readable when the figure is
 * what matters and the bar is only there for shape.
 *
 * Colour is not decoration: it is the reading. Past 65% the bar turns yellow and
 * past 85% red, whatever tone the caller asked for, because at that point the
 * value means something the caller does not get to soften.
 */
export const MetricGauge: React.FC<MetricGaugeProps> = ({
  label,
  value,
  displayValue,
  detail,
  tone = 'accent',
}) => {
  const clampedValue = Math.min(100, Math.max(0, value));
  const effectiveTone: StatusLevel =
    clampedValue > 85 ? 'bad' : clampedValue > 65 ? 'warn' : tone;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-tui">
        <span className="min-w-0 truncate text-tui-muted">{label}</span>
        <span className={cn('shrink-0 font-bold', TONE[effectiveTone].text)}>{displayValue}</span>
      </div>

      <Meter
        value={clampedValue / 100}
        width={28}
        tone={effectiveTone}
        className="w-full overflow-hidden text-tui-sm"
      />

      {detail && <div className="text-tui-sm text-tui-faint">{detail}</div>}
    </div>
  );
};
