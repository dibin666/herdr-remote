import type React from 'react';
import { cn } from '@/shared/lib/cn';

/* ------------------------------------------------------------------- table */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Width in characters; omit to let the column take what is left. */
  width?: number;
  align?: 'left' | 'right';
  className?: string;
  render: (item: T, index: number) => React.ReactNode;
}

/**
 * A table with rules instead of zebra stripes.
 *
 * The heading is uppercase and dim; a hovered row is inverse-video, exactly as
 * a selected row is in the Herdr sidebar.
 */
export function Table<T>({
  columns,
  items,
  rowKey,
  empty,
  className,
}: {
  columns: Column<T>[];
  items: T[];
  rowKey: (item: T, index: number) => string;
  empty: React.ReactNode;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <div className={cn('px-1 py-4 text-center text-tui text-tui-faint', className)}>{empty}</div>
    );
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse text-tui">
        <thead>
          <tr className="border-b border-tui-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: `${column.width}ch` } : undefined}
                className={cn(
                  'whitespace-nowrap px-2 py-1 text-tui-sm font-bold text-tui-muted',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={rowKey(item, index)}
              className="border-b border-tui-border-dim last:border-b-0 hover:bg-tui-selection"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'px-2 py-1 align-top text-tui-text',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.className,
                  )}
                >
                  {column.render(item, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
