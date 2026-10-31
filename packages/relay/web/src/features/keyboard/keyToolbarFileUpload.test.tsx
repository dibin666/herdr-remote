import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PASTE_MAX_BYTES } from '@protocol/paste';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '@/app/ToastContainer';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import * as imagePasteModule from '@/features/paste/imagePaste';
import { saveSettings } from '@/features/settings/storage';
import { TerminalView } from '@/features/terminal/TerminalView';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';
import { KeyToolbar } from './KeyToolbar';

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

function sentPastes(ws: MockWebSocket) {
  return ws.sent
    .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
    .filter((m) => m?.type === 'paste_file');
}

describe('KeyToolbar file upload', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    vi.restoreAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const setupTestSession = (role: 'controller' | 'viewer' = 'controller') => {
    saveSettings({ toolbarVisible: true, language: 'zh' });
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
      emitAdapterEvent(capturedCtx, 'sessionReady', {});
      if (role === 'controller') emitAdapterEvent(capturedCtx, 'controlGranted');
      else emitAdapterEvent(capturedCtx, 'roleChange', 'viewer', 'other-controller');
    });
    return { getCtx: () => capturedCtx, ws };
  };

  it('sits beside the image button with a paperclip icon and its own labels', () => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    render(
      <TerminalProvider>
        <KeyToolbar compact={false} />
      </TerminalProvider>,
    );
    const btn = screen.getByTestId('file-upload-btn');
    expect(btn).toHaveAttribute('aria-label', 'Upload File');
    expect(btn).toHaveAttribute('title', expect.stringContaining('any file'));
    expect(btn.textContent).toBe('\u{F03E2}');
    expect(btn.nextElementSibling).toBe(screen.getByTestId('image-upload-btn'));
  });

  it('opens a picker that accepts any file type', () => {
    setupTestSession();
    const input = screen.getByTestId('key-toolbar-any-file-input') as HTMLInputElement;
    expect(input.hasAttribute('accept')).toBe(false);
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('file-upload-btn'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('does not open the picker in viewer mode', () => {
    setupTestSession('viewer');
    const input = screen.getByTestId('key-toolbar-any-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('file-upload-btn'));
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/观察者模式/i)).toBeInTheDocument();
  });

  it('sends the file untouched under its name and pastes back the saved path', async () => {
    const compressSpy = vi.spyOn(imagePasteModule, 'compressAndPrepareImage');
    const { getCtx, ws } = setupTestSession();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.paste = vi.fn();

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-toolbar-any-file-input'), {
        target: { files: [file] },
      });
    });

    await waitFor(() => expect(sentPastes(ws)).toHaveLength(1));
    const [msg] = sentPastes(ws);
    expect(msg.mime).toBe('application/octet-stream');
    expect(msg.name).toBe('notes.txt');
    expect(msg.dataBase64).toBe('aGVsbG8=');
    expect(compressSpy).not.toHaveBeenCalled();

    // Only the button that started the upload shows its percentage.
    expect(screen.getByTestId('file-upload-btn').textContent).toBe('88%');
    expect(screen.getByTestId('image-upload-btn')).toBeDisabled();
    expect(screen.getByTestId('image-upload-btn').textContent).toBe('\u{F02E9}');

    await act(async () => {
      emitAdapterEvent(getCtx(), 'pasteFileReady', '/state/pasted/uuid-notes.txt');
    });
    expect(term.paste).toHaveBeenCalledWith('/state/pasted/uuid-notes.txt');
    expect(screen.getByText('完成')).toBeInTheDocument();
  });

  it('sends each picked file one after another and pastes both paths', async () => {
    const { getCtx, ws } = setupTestSession();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.paste = vi.fn();

    const one = new File(['1'], 'one.txt');
    const two = new File(['2'], 'two.txt');
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-toolbar-any-file-input'), {
        target: { files: [one, two] },
      });
    });

    // The batch walks the wire one file at a time: the second goes only after
    // the host answers for the first.
    await waitFor(() => expect(sentPastes(ws)).toHaveLength(1));
    expect(sentPastes(ws)[0].name).toBe('one.txt');

    await act(async () => {
      emitAdapterEvent(getCtx(), 'pasteFileReady', '/p/one.txt');
    });
    await waitFor(() => expect(sentPastes(ws)).toHaveLength(2));
    expect(sentPastes(ws)[1].name).toBe('two.txt');

    await act(async () => {
      emitAdapterEvent(getCtx(), 'pasteFileReady', '/p/two.txt');
    });
    expect(term.paste).toHaveBeenNthCalledWith(1, '/p/one.txt');
    expect(term.paste).toHaveBeenNthCalledWith(2, '/p/two.txt');
  });

  it('refuses a file over the size limit without sending it', async () => {
    const { ws } = setupTestSession();
    const file = new File(['x'], 'big.bin');
    Object.defineProperty(file, 'size', { value: PASTE_MAX_BYTES + 1 });
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-toolbar-any-file-input'), {
        target: { files: [file] },
      });
    });
    expect(await screen.findByText('文件超过 3 MB 上传上限。')).toBeInTheDocument();
    expect(sentPastes(ws)).toHaveLength(0);
    expect(screen.queryByTestId('key-toolbar-progress')).toBeNull();
  });

  it('explains when the workstation is too old to receive files', async () => {
    const { getCtx } = setupTestSession();
    await act(async () => {
      fireEvent.change(screen.getByTestId('key-toolbar-any-file-input'), {
        target: { files: [new File(['hi'], 'a.txt')] },
      });
    });
    await waitFor(() => expect(screen.getByText(/等待工作站保存/)).toBeInTheDocument());
    await act(async () => {
      emitAdapterEvent(getCtx(), 'error', {
        code: 'paste_file_host_outdated',
        message: 'Host is too old to receive files; update herdr-remote',
      });
    });
    expect(await screen.findByText(/版本过旧，无法接收文件/)).toBeInTheDocument();
    expect(screen.queryByTestId('key-toolbar-progress')).toBeNull();
  });
});
