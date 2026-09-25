import type { ConnectedClientInfo } from '../../types/admin';

type Translate = (path: string, params?: Record<string, string | number>) => string;

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * An uptime in the interface's own units.
 *
 * `1h 24m 1s` is English abbreviation, and it stayed English on a Chinese
 * screen — which is exactly the kind of leftover that makes a translated UI
 * read as half-translated. `compact` keeps the two largest units, which is all
 * a headline figure has room for.
 */
export function formatUptime(seconds: number, t: Translate, compact = false): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const unit = (value: number, key: string) => `${value}${t(`admin.unit${key}`)}`;
  const parts = days > 0
    ? [unit(days, 'Day'), unit(hours, 'Hour'), unit(mins, 'Minute')]
    : hours > 0
      ? [unit(hours, 'Hour'), unit(mins, 'Minute'), unit(secs, 'Second')]
      : [unit(mins, 'Minute'), unit(secs, 'Second')];
  return (compact ? parts.slice(0, 2) : parts).join(' ');
}

/**
 * How long ago, in the largest whole unit.
 *
 * An operator scanning a roster wants "3 days ago", not a timestamp to subtract
 * in their head; the exact time stays available as the cell's tooltip.
 */
export function formatRelative(value: string | undefined, t: Translate, now = Date.now()): string {
  if (!value) return '—';
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return '—';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return t('admin.relJustNow');
  if (seconds < 3600) return t('admin.relMinutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('admin.relHours', { count: Math.floor(seconds / 3600) });
  return t('admin.relDays', { count: Math.floor(seconds / 86400) });
}

export function formatTimestamp(value?: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

/**
 * How many windows each paired device has open right now.
 *
 * Only the operator response says which device a connection authenticated as,
 * so on `/api/status` this is empty and nothing is drawn as online or offline.
 */
export function windowsByDevice(clients: ConnectedClientInfo[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const client of clients) {
    if (!client.deviceId) continue;
    counts.set(client.deviceId, (counts.get(client.deviceId) || 0) + 1);
  }
  return counts;
}
