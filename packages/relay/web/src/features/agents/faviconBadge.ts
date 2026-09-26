import type { AttentionLevel } from './agentAttention';

/**
 * A dot on the tab's icon while an agent is waiting, in the status colours
 * the rest of the interface uses: yellow for blocked, green for done.
 *
 * The icon is an SVG `data:` URL (see index.html), which the relay's CSP
 * already allows as `img-src data:`, so the badge is drawn by editing the SVG
 * rather than painting a canvas.
 */
const BADGE_COLORS: Record<AttentionLevel, string> = {
  blocked: '%23f9e2af',
  done: '%23a6e3a1',
};

function badgeMarkup(level: AttentionLevel): string {
  return `<circle cx='19' cy='5' r='4.5' fill='${BADGE_COLORS[level]}' stroke='%2311111b' stroke-width='1.5'/>`;
}

/** The icon URL with the badge added, or the icon unchanged if it is not an SVG. */
export function withFaviconBadge(baseHref: string, level: AttentionLevel | null): string {
  if (!level || !baseHref.includes('</svg>')) return baseHref;
  return baseHref.replace('</svg>', `${badgeMarkup(level)}</svg>`);
}

/** Puts the badge on the page's icon, or takes it off with `null`. */
export function applyFaviconBadge(level: AttentionLevel | null, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) return;
  if (link.dataset.baseHref === undefined) link.dataset.baseHref = link.getAttribute('href') ?? '';
  const next = withFaviconBadge(link.dataset.baseHref, level);
  if (link.getAttribute('href') !== next) link.setAttribute('href', next);
}
