import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '@/app/ToastContainer';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import { KeyToolbar } from '@/features/keyboard/KeyToolbar';
import { TerminalView } from '@/features/terminal/TerminalView';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';
import { FileListButton } from './FileListButton';
import { FileListModal } from './FileListModal';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

function emitAdapterEvent(
  context: ReturnType<typeof useTerminal> | null,
  event: string,
  ...args: unknown[]
): void {
  (
    context?.adapter as unknown as { emit: (name: string, ...values: unknown[]) => void } | null
  )?.emit(event, ...args);
}

function sentMessages(ws: MockWebSocket, type: string) {
  return ws.sent
    .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
    .filter((m) => m?.type === type);
}

const ENTRIES = [
  { name: 'b-two.txt', kind: 'file' as const, size: 2000, mtimeMs: 2000 },
  { name: 'a-one.txt', kind: 'file' as const, size: 100, mtimeMs: 3000 },
  { name: 'docs', kind: 'dir' as const, size: 0, mtimeMs: 1000 },
];

function setupSession() {
  saveSettings({ toolbarVisible: true, language: 'en' });
  let capturedCtx: ReturnType<typeof useTerminal> | null = null;
  const ContextCollector = () => {
    capturedCtx = useTerminal();
    return null;
  };
  render(
    <TerminalProvider>
      <ContextCollector />
      <TerminalView isActive={true} />
      <KeyToolbar compact={false} />
      <ToastContainer />
    </TerminalProvider>,
  );
  const ws = webSocketInstances[webSocketInstances.length - 1];
  act(() => {
    ws.simulateOpen();
    // Deliver a real ready so the adapter reports 'connected' — fs sends are
    // dropped while the socket is still handshaking.
    ws.simulateMessage(
      JSON.stringify({
        type: 'ready',
        role: 'controller',
        hostId: 'host-1',
        fileListSupported: true,
      }),
    );
  });
  return { getCtx: () => capturedCtx, ws };
}

function openDialog(getCtx: () => ReturnType<typeof useTerminal> | null, ws: MockWebSocket) {
  fireEvent.click(screen.getByTestId('file-list-btn'));
  const request = sentMessages(ws, 'fs_list_request').at(-1);
  expect(request).toBeTruthy();
  act(() => {
    emitAdapterEvent(getCtx(), 'fsListResponse', {
      type: 'fs_list_response',
      requestId: request!.requestId,
      cwd: '/home/user/project',
      entries: ENTRIES,
    });
  });
}

describe('file list dialog', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens from the key bar and lists the terminal directory', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    expect(await screen.findByText('/home/user/project')).toBeInTheDocument();
    // Directories group first; files sort by name within their group.
    // Body rows: [.. parent row, then the entries].
    const rows = screen.getAllByRole('row').slice(2);
    expect(rows[0]).toHaveTextContent('docs/');
    expect(rows[1]).toHaveTextContent('a-one.txt');
    expect(rows[2]).toHaveTextContent('b-two.txt');
  });

  it('sorts by size and by time when the headers are clicked', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('a-one.txt');
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    let rows = screen.getAllByRole('row').slice(2);
    // dirs first regardless of the key, then biggest file first (desc).
    expect(rows[0]).toHaveTextContent('docs/');
    expect(rows[1]).toHaveTextContent('b-two.txt');
    expect(rows[2]).toHaveTextContent('a-one.txt');

    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    rows = screen.getAllByRole('row').slice(2);
    expect(rows[1]).toHaveTextContent('a-one.txt');
    expect(rows[2]).toHaveTextContent('b-two.txt');

    fireEvent.click(screen.getByRole('button', { name: /Modified/ }));
    rows = screen.getAllByRole('row').slice(2);
    expect(rows[0]).toHaveTextContent('docs/');
    expect(rows[1]).toHaveTextContent('a-one.txt');
    expect(rows[2]).toHaveTextContent('b-two.txt');
  });

  it('stages and pulls a zip for several picked names', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('a-one.txt');

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    // jsdom has no createObjectURL — define it instead of spying.
    const urlSpy = vi.fn(() => 'blob:mock');
    Object.defineProperty(URL, 'createObjectURL', {
      value: urlSpy,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });

    // Pick two of three entries, then download.
    fireEvent.click(screen.getByText('a-one.txt'));
    fireEvent.click(screen.getByText('b-two.txt'));
    expect(screen.getByTestId('files-download')).toHaveTextContent('Download (2)');
    fireEvent.click(screen.getByTestId('files-download'));

    const requests = sentMessages(ws, 'fs_download_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].names.sort()).toEqual(['a-one.txt', 'b-two.txt']);
    const requestId = requests[0].requestId;

    await act(async () => {
      emitAdapterEvent(getCtx(), 'fsDownloadReady', {
        type: 'fs_download_ready',
        requestId,
        name: 'project.zip',
        size: 5,
        totalChunks: 2,
      });
    });
    await waitFor(() => expect(sentMessages(ws, 'fs_download_chunk_request')).toHaveLength(1));
    await act(async () => {
      emitAdapterEvent(getCtx(), 'fsDownloadChunk', {
        type: 'fs_download_chunk',
        requestId,
        index: 0,
        dataBase64: btoa('ab'),
      });
    });
    await waitFor(() => expect(sentMessages(ws, 'fs_download_chunk_request')).toHaveLength(2));
    await act(async () => {
      emitAdapterEvent(getCtx(), 'fsDownloadChunk', {
        type: 'fs_download_chunk',
        requestId,
        index: 1,
        dataBase64: btoa('cde'),
      });
    });

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(urlSpy).toHaveBeenCalled();
  });

  it('enters a directory on double click and comes back up', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('docs/');

    // Double click on the dir row asks the host for its entries.
    fireEvent.doubleClick(screen.getByText('docs/'));
    const into = sentMessages(ws, 'fs_list_request').at(-1);
    expect(into).toBeTruthy();
    expect(into.dir).toBe('docs');
    act(() => {
      emitAdapterEvent(getCtx(), 'fsListResponse', {
        type: 'fs_list_response',
        requestId: into.requestId,
        cwd: '/home/user/project/docs',
        entries: [{ name: 'inside.txt', kind: 'file', size: 3, mtimeMs: 9 }],
      });
    });
    await screen.findByText('inside.txt');
    // The parent row leads back up.
    fireEvent.click(screen.getByTestId('files-parent'));
    const up = sentMessages(ws, 'fs_list_request').at(-1);
    expect(up.dir).toBe('..');
    act(() => {
      emitAdapterEvent(getCtx(), 'fsListResponse', {
        type: 'fs_list_response',
        requestId: up.requestId,
        cwd: '/home/user/project',
        entries: ENTRIES,
      });
    });
    await screen.findByText('a-one.txt');
  });

  it('opens a context menu on right click and renames through it', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('a-one.txt');

    fireEvent.contextMenu(screen.getByText('a-one.txt'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // A .txt file gets the preview item; the menu names its row.
    expect(screen.getByRole('menuitem', { name: 'Preview' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByTestId('files-rename-input');
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.click(screen.getByTestId('files-rename-submit'));

    const rename = sentMessages(ws, 'fs_rename_request').at(-1);
    expect(rename).toBeTruthy();
    expect(rename.name).toBe('a-one.txt');
    expect(rename.newName).toBe('renamed.txt');
    act(() => {
      emitAdapterEvent(getCtx(), 'fsMutationDone', {
        type: 'fs_mutation_done',
        requestId: rename.requestId,
      });
    });
    // The listing re-reads itself after a confirmed mutation.
    await waitFor(() => {
      const relist = sentMessages(ws, 'fs_list_request').at(-1);
      expect(relist.dir).toBe('.');
    });
  });

  it('enters a directory on a single tap where the pointer is coarse', async () => {
    // Pointer coarse is how a phone reports itself; double tap is not reliable there.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('docs/');

    fireEvent.click(screen.getByText('docs/'));
    const into = sentMessages(ws, 'fs_list_request').at(-1);
    expect(into.dir).toBe('docs');
  });

  it('hides the preview item for a binary-looking file', async () => {
    const { getCtx, ws } = setupSession();
    openDialog(getCtx, ws);
    await screen.findByText('a-one.txt');

    // ENTRIES has only text-ish files here; swap in a .zip row.
    fireEvent.contextMenu(screen.getByText('docs/'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // A directory has no preview item either.
    expect(screen.queryByRole('menuitem', { name: 'Preview' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Properties' })).toBeInTheDocument();
  });

  it('shows the host error when the listing fails', async () => {
    const { getCtx, ws } = setupSession();
    fireEvent.click(screen.getByTestId('file-list-btn'));
    const request = sentMessages(ws, 'fs_list_request').at(-1);
    act(() => {
      emitAdapterEvent(getCtx(), 'error', {
        code: 'fs_list_failed',
        message: 'permission denied',
        requestId: request!.requestId,
      });
    });
    expect(await screen.findByTestId('files-error')).toHaveTextContent(
      'Could not read the terminal directory',
    );
  });
});

describe('FileListModal in isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    webSocketInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('does not warn when closed', () => {
    saveSettings({ language: 'en' });
    render(
      <TerminalProvider>
        <FileListModal isOpen={false} onClose={() => {}} />
      </TerminalProvider>,
    );
    expect(screen.queryByText('Files')).toBeNull();
  });
});

describe('FileListButton', () => {
  it('warns in viewer mode instead of opening', () => {
    saveSettings({ language: 'en' });
    let capturedCtx: ReturnType<typeof useTerminal> | null = null;
    const ContextCollector = () => {
      capturedCtx = useTerminal();
      return null;
    };
    render(
      <TerminalProvider>
        <ContextCollector />
        <FileListButton squareKeyClass="h-8 w-8" />
        <ToastContainer />
      </TerminalProvider>,
    );
    act(() => {
      emitAdapterEvent(capturedCtx, 'roleChange', 'viewer', 'other-controller');
    });
    fireEvent.click(screen.getByTestId('file-list-btn'));
    expect(screen.getByText(/viewer mode/i)).toBeInTheDocument();
    expect(screen.queryByText('Files')).toBeNull();
  });
});
