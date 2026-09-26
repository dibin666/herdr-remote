import { describe, it, expect } from 'vitest';
import {
  attentionCounts,
  attentionLevel,
  formatAttentionPrefix,
  newAttention,
} from './agentAttention';
import { applyFaviconBadge, withFaviconBadge } from './faviconBadge';
import type { ServerAgentStatusMessage } from '@protocol/messages';

const report = (
  agents: Array<[string, string]>,
  counts: ServerAgentStatusMessage['counts'] = {},
): ServerAgentStatusMessage => ({
  type: 'agent_status',
  counts,
  total: agents.length,
  agents: agents.map(([paneId, status]) => ({
    paneId,
    workspaceId: 'w',
    agent: 'claude',
    title: null,
    status,
    focused: false,
  })),
});

describe('agent attention', () => {
  it('counts only what waits for a person', () => {
    const counts = attentionCounts(report([], { blocked: 2, done: 1, working: 4 }));
    expect(counts).toEqual({ blocked: 2, done: 1 });
    expect(formatAttentionPrefix(counts)).toBe('(2⚠ 1✓)');
    expect(formatAttentionPrefix({ blocked: 0, done: 3 })).toBe('(3✓)');
    expect(formatAttentionPrefix({ blocked: 0, done: 0 })).toBe('');
    expect(formatAttentionPrefix(null)).toBe('');
    expect(attentionLevel(counts)).toBe('blocked');
    expect(attentionLevel({ blocked: 0, done: 1 })).toBe('done');
    expect(attentionLevel({ blocked: 0, done: 0 })).toBeNull();
  });

  it('treats the first report after connecting as a baseline, not news', () => {
    expect(newAttention(null, report([['p1', 'blocked']], { blocked: 1 }))).toBeNull();
  });

  it('reports an agent that has just stopped to ask, ahead of one that finished', () => {
    const before = report(
      [
        ['p1', 'working'],
        ['p2', 'working'],
      ],
      { working: 2 },
    );
    expect(
      newAttention(
        before,
        report(
          [
            ['p1', 'done'],
            ['p2', 'working'],
          ],
          { done: 1, working: 1 },
        ),
      ),
    ).toBe('done');
    expect(
      newAttention(
        before,
        report(
          [
            ['p1', 'done'],
            ['p2', 'blocked'],
          ],
          { done: 1, blocked: 1 },
        ),
      ),
    ).toBe('blocked');
  });

  it('stays quiet while nothing changes, and when agents go back to work', () => {
    const waiting = report([['p1', 'blocked']], { blocked: 1 });
    expect(newAttention(waiting, report([['p1', 'blocked']], { blocked: 1 }))).toBeNull();
    expect(newAttention(waiting, report([['p1', 'working']], { working: 1 }))).toBeNull();
  });

  it('notices a count that rose beyond the capped agent list', () => {
    const before = report([], { blocked: 0 });
    expect(newAttention(before, report([], { blocked: 1 }))).toBe('blocked');
  });
});

describe('favicon badge', () => {
  const base = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";

  it('adds a dot in the status colour, and nothing for a non-SVG icon', () => {
    expect(withFaviconBadge(base, 'blocked')).toContain("fill='%23f9e2af'");
    expect(withFaviconBadge(base, 'done')).toContain("fill='%23a6e3a1'");
    expect(withFaviconBadge(base, null)).toBe(base);
    expect(withFaviconBadge('/favicon.png', 'blocked')).toBe('/favicon.png');
  });

  it('puts the badge on the page icon and takes it off again', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = base;
    document.head.appendChild(link);
    try {
      applyFaviconBadge('blocked');
      expect(link.getAttribute('href')).toContain('<circle');
      applyFaviconBadge('done');
      expect(link.getAttribute('href')!.match(/<circle/g)).toHaveLength(1);
      applyFaviconBadge(null);
      expect(link.getAttribute('href')).toBe(base);
    } finally {
      link.remove();
    }
  });
});
