import React from 'react';
import { cn } from '../../utils/cn';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: string;
  trendType?: 'positive' | 'negative' | 'neutral';
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  trendType = 'neutral',
  className,
}) => {
  return (
    <div
      className={cn(
        'bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-4 sm:p-5 flex flex-col justify-between shadow-sm relative overflow-hidden transition-colors',
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-charcoal-500 dark:text-charcoal-400">
            {title}
          </span>
          <div className="mt-1 text-2xl font-bold text-charcoal-900 dark:text-charcoal-100 font-mono tracking-tight">
            {value}
          </div>
        </div>
        <div className="p-2.5 rounded-xl bg-sand-100 dark:bg-charcoal-750 border border-sand-300 dark:border-charcoal-650 text-herdr-600 dark:text-herdr-400 shadow-sm">
          {icon}
        </div>
      </div>

      {(subtitle || trend) && (
        <div className="mt-3 flex items-center justify-between text-xs text-charcoal-500 dark:text-charcoal-400">
          {subtitle && <span>{subtitle}</span>}
          {trend && (
            <span
              className={cn(
                'font-medium text-[11px] px-2 py-0.5 rounded-full',
                trendType === 'positive'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : trendType === 'negative'
                  ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 border border-red-200 dark:border-red-800'
                  : 'bg-sand-200 text-charcoal-700 dark:bg-charcoal-700 dark:text-charcoal-200'
              )}
            >
              {trend}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
