/**
 * Turn a raw User-Agent string into something an operator can recognise.
 *
 * The relay dashboard lists devices so a person can decide which one to revoke.
 * A 200-character UA string does not help with that decision — "iPhone ·
 * Safari" does. This is deliberately a coarse, best-effort summary: it only has
 * to be good enough to tell *your* phone from *your* laptop, and it never
 * claims precision it does not have.
 */

export interface DeviceDescription {
  /** Short label such as `iPhone · Safari`. Empty when the UA is unusable. */
  label: string;
  /** The untouched UA string, for the title attribute / detail view. */
  raw: string;
}

const PLATFORM_RULES: Array<[RegExp, string]> = [
  [/\biPhone\b/i, 'iPhone'],
  [/\biPad\b/i, 'iPad'],
  [/\biPod\b/i, 'iPod'],
  // Windows advertises itself inside Android UA strings on some tablets, so
  // Android is tested first.
  [/\bAndroid\b/i, 'Android'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bWindows NT\b/i, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bLinux\b/i, 'Linux'],
];

const BROWSER_RULES: Array<[RegExp, string]> = [
  // Order matters: every Chromium browser also says "Chrome", and Chrome on
  // iOS says "CriOS" while still claiming Safari.
  [/\bEdgA?\/|\bEdge\//i, 'Edge'],
  [/\bOPR\/|\bOpera\//i, 'Opera'],
  [/\bSamsungBrowser\//i, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//i, 'Firefox'],
  [/\bCriOS\//i, 'Chrome'],
  [/\bChrome\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
];

function matchFirst(rules: Array<[RegExp, string]>, value: string): string | null {
  for (const [pattern, name] of rules) {
    if (pattern.test(value)) return name;
  }
  return null;
}

export function describeUserAgent(userAgent?: string | null): DeviceDescription {
  const raw = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!raw) return { label: '', raw: '' };

  const platform = matchFirst(PLATFORM_RULES, raw);
  const browser = matchFirst(BROWSER_RULES, raw);

  if (platform && browser) return { label: `${platform} · ${browser}`, raw };
  if (platform) return { label: platform, raw };
  if (browser) return { label: browser, raw };

  // Unrecognised agent (a script, a niche browser): show a trimmed prefix
  // rather than nothing, so the row is still distinguishable.
  return { label: raw.length > 32 ? `${raw.slice(0, 32)}…` : raw, raw };
}
