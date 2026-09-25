import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';
import {
  BASE_DOCUMENT_TITLE,
  applyDocumentTitle,
  formatDocumentTitle,
  sanitizeTerminalTitle,
} from '../utils/documentTitle';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const CtxProbe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

/**
 * The tab is named after this window's own Herdr client.
 *
 * Herdr 0.9.1 is what makes that name trustworthy — before it, a client's
 * window title could follow another client's selection — so these tests pin the
 * two things that decide what a tab says: what survives sanitizing, and what a
 * window falls back to when there is no session title to show.
 */

describe('document title', () => {
  afterEach(() => {
    document.title = BASE_DOCUMENT_TITLE;
  });

  it('keeps a plain title and appends the product name', () => {
    expect(formatDocumentTitle('Claude Code')).toBe('Claude Code · Herdr Remote');
  });

  it('drops control characters instead of letting a pane forge a title', () => {
    expect(sanitizeTerminalTitle('Claude\u0007 Code\u001B[31m')).toBe('Claude Code [31m');
    expect(sanitizeTerminalTitle('two\nlines\ttabbed')).toBe('two lines tabbed');
    expect(sanitizeTerminalTitle('\u0000\u0001\u0002')).toBe('');
  });

  it('clamps a long title rather than filling the tab strip', () => {
    const long = 'w'.repeat(200);
    const clamped = sanitizeTerminalTitle(long);
    expect(clamped).toHaveLength(80);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('falls back to the profile so a disconnected tab still names its workstation', () => {
    expect(formatDocumentTitle(null, 'workshop')).toBe('workshop · Herdr Remote');
    expect(formatDocumentTitle('', '')).toBe(BASE_DOCUMENT_TITLE);
    expect(formatDocumentTitle(undefined, undefined)).toBe(BASE_DOCUMENT_TITLE);
  });

  it('writes the computed title to the document', () => {
    applyDocumentTitle('herdr-remote', 'workshop');
    expect(document.title).toBe('herdr-remote · Herdr Remote');

    applyDocumentTitle(null, 'workshop');
    expect(document.title).toBe('workshop · Herdr Remote');
  });

  it('rejects a non-string title without throwing', () => {
    expect(sanitizeTerminalTitle(undefined)).toBe('');
    expect(sanitizeTerminalTitle(42 as unknown as string)).toBe('');
  });
});

describe('The tab follows this window’s own session', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    document.title = BASE_DOCUMENT_TITLE;
  });

  afterEach(() => {
    document.title = BASE_DOCUMENT_TITLE;
  });

  const connectedView = async (isActive: boolean) => {
    saveSettings({ token: 'title-token' });
    let ctx: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <CtxProbe
          onReady={(value) => {
            ctx = value;
          }}
        />
        <TerminalView isActive={isActive} />
      </TerminalProvider>,
    );
    await waitFor(() => expect(xtermInstances.length).toBeGreaterThan(0));
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit('sessionReady', { type: 'session_ready' });
    });
    return { ctx, term: xtermInstances[0] };
  };

  it('renames the tab when the window’s Herdr client announces a title', async () => {
    const { term } = await connectedView(true);

    act(() => {
      term.emitTitleChange?.('◑ Claude Code');
    });

    await waitFor(() => expect(document.title).toBe('◑ Claude Code · Herdr Remote'));
  });

  it('leaves the tab alone while the terminal layer is not the visible one', async () => {
    const { term } = await connectedView(false);

    act(() => {
      term.emitTitleChange?.('◑ Claude Code');
    });

    // The profile still names the tab; the hidden session does not.
    await waitFor(() => expect(document.title).not.toContain('Claude Code'));
    expect(document.title.endsWith(BASE_DOCUMENT_TITLE)).toBe(true);
  });

  it('leads with the agents that are waiting, while the badge setting is on', async () => {
    const { ctx, term } = await connectedView(true);
    act(() => {
      term.emitTitleChange?.('◑ Claude Code');
    });
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit('agentStatus', {
        type: 'agent_status',
        counts: { blocked: 1, done: 2 },
        total: 3,
        agents: [],
      });
    });
    await waitFor(() => expect(document.title).toBe('(1⚠ 2✓) ◑ Claude Code · Herdr Remote'));

    act(() => {
      ctx?.updateSettings({ agentAlertBadge: false });
    });
    await waitFor(() => expect(document.title).toBe('◑ Claude Code · Herdr Remote'));
  });

  it('drops a title that belonged to a session that has ended', async () => {
    const { ctx, term } = await connectedView(true);
    act(() => {
      term.emitTitleChange?.('◑ Claude Code');
    });
    await waitFor(() => expect(document.title).toBe('◑ Claude Code · Herdr Remote'));

    // A reconnect starts a fresh Herdr client, so the old view's name is stale.
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit('stateChange', 'reconnecting', null, null);
    });

    await waitFor(() => expect(document.title).not.toContain('Claude Code'));
    expect(document.title.endsWith(BASE_DOCUMENT_TITLE)).toBe(true);
  });
});
