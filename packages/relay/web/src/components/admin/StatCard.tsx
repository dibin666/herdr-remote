import React from 'react';
import { cn } from '../../utils/cn';
import { Badge, StatusLevel, TONE } from '../tui';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  /** A short state word shown at the bottom right, e.g. `LIVE`. */
  trend?: string;
  trendTone?: StatusLevel;
  /**
   * Colours the figure itself when the number is the point. The default reads
   * as ordinary body text: a board where every number is coloured says nothing.
   */
  tone?: StatusLevel | 'plain';
  className?: string;
}

/**
 * One headline figure.
 *
 * A dim uppercase label, the number underneath in the largest size this
 * interface uses, and a caption. No icon and no tile: on a status board the
 * number is the content, and a picture beside it only competes with it.
 */
export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  trend,
  trendTone = 'ok',
  tone = 'plain',
  className,
}) => (
  <div
    className={cn(
      'flex flex-col justify-between border border-tui-border bg-tui-base px-3 py-2',
      className
    )}
  >
    <div>
      <span className="block text-tui-sm uppercase text-tui-muted">{title}</span>
      <div
        className={cn(
          'mt-0.5 truncate text-tui-lg font-bold',
          tone === 'plain' ? 'text-tui-text' : TONE[tone].text
        )}
        title={String(value)}
      >
        {value}
      </div>
    </div>

    {(subtitle || trend) && (
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-tui-sm text-tui-faint">
        {subtitle && <span className="min-w-0 truncate">{subtitle}</span>}
        {trend && (
          <Badge tone={trendTone} dot className="shrink-0">
            {trend}
          </Badge>
        )}
      </div>
    )}
  </div>
);
