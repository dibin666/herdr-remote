import React from 'react';
import { cn } from '../../utils/cn';

interface MetricGaugeProps {
  label: string;
  value: number; // 0 to 100
  displayValue: string;
  detail?: string;
  color?: 'herdr' | 'emerald' | 'amber' | 'red';
}

const COLOR_CLASSES = {
  herdr: {
    bar: 'bg-herdr-700',
    text: 'text-herdr-700 dark:text-herdr-400',
  },
  emerald: {
    bar: 'bg-emerald-600',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  amber: {
    bar: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
  },
  red: {
    bar: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
  },
};

export const MetricGauge: React.FC<MetricGaugeProps> = ({
  label,
  value,
  displayValue,
  detail,
  color = 'herdr',
}) => {
  const clampedValue = Math.min(100, Math.max(0, value));
  const autoColor =
    clampedValue > 85 ? 'red' : clampedValue > 65 ? 'amber' : color;
  const classes = COLOR_CLASSES[autoColor];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-charcoal-700 dark:text-charcoal-300 font-medium">{label}</span>
        <span className={cn('font-mono font-bold', classes.text)}>{displayValue}</span>
      </div>

      <div className="w-full h-2 bg-sand-200 dark:bg-charcoal-700 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', classes.bar)}
          style={{ width: `${clampedValue}%` }}
        />
      </div>

      {detail && <div className="text-[10px] text-charcoal-500 dark:text-charcoal-400">{detail}</div>}
    </div>
  );
};
