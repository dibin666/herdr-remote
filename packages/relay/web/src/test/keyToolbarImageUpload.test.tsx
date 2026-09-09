import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { KeyToolbar } from '../components/KeyToolbar';
import { TerminalView } from '../components/TerminalView';
import { ToastContainer } from '../components/ToastContainer';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import * as imagePasteModule from '../utils/imagePaste';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

function emitAdapterEvent(
  context: ReturnType<typeof useTerminal> | null,
  event: string,
  ...args: unknown[]
): void {
  (context?.adapter as unknown as { emit: (name: string, ...values: unknown[]) => void } | null)?.emit(
    event,
    ...args
  );
}

describe('KeyToolbar Image Upload & Progress Integration', () => {
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

  const setupTestSession = (role: 'controller' | 'viewer' = 'controller', language: 'zh' | 'en' = 'zh') => {
    saveSettings({ toolbarVisible: true, language });
    let capturedCtx: ReturnType<typeof useTerminal> | null = null;
    const ContextCollector = () => {
      capturedCtx = useTerminal();
      return null;
    };

    const utils = render(
      <TerminalProvider>
        <ContextCollector />
        <TerminalView isActive={true} />
        <KeyToolbar compact={false} />
        <ToastContainer />
      </TerminalProvider>
    );

    const lastWs = webSocketInstances[webSocketInstances.length - 1];
    if (lastWs) {
      act(() => {
        lastWs.simulateOpen();
        emitAdapterEvent(capturedCtx, 'sessionReady', {});
      });
      if (role === 'controller') {
        act(() => {
          emitAdapterEvent(capturedCtx, 'controlGranted');
        });
      } else {
        act(() => {
          emitAdapterEvent(capturedCtx, 'controlRevoked', 'other-controller');
        });
      }
    }

    return { ...utils, getCtx: () => capturedCtx, getWs: () => lastWs };
  };

  it('renders fixed image upload button in both desktop and compact modes', () => {
    // 1. Desktop mode
    saveSettings({ toolbarVisible: true, language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <KeyToolbar compact={false} />
      </TerminalProvider>
    );

    const desktopBtn = screen.getByTestId('image-upload-btn');
    expect(desktopBtn).toBeInTheDocument();
    expect(desktopBtn).toHaveAttribute('aria-label', '上传图片');
    expect(desktopBtn).toHaveAttribute('title', '选择图片并上传至终端');
    expect(desktopBtn.textContent).toContain('图片');
    // Does not render emoji square 🖼️
    expect(desktopBtn.textContent).not.toContain('🖼️');
    // Shares the same standard key class (CAP_BASE + keyClass) instead of standalone large button
    expect(desktopBtn.className).toContain('h-9');
    expect(desktopBtn.className).not.toContain('min-h-[44px]');

    unmount();

    // 2. Compact / mobile shell mode
    render(
      <TerminalProvider>
        <KeyToolbar compact={true} />
      </TerminalProvider>
    );

    const compactBtn = screen.getByTestId('image-upload-btn');
    expect(compactBtn).toBeInTheDocument();
    expect(compactBtn).toHaveAttribute('aria-label', '上传图片');
    expect(compactBtn.textContent).toContain('图片');
    expect(compactBtn.textContent).not.toContain('🖼️');
    expect(compactBtn.className).toContain('h-9');
    expect(compactBtn.className).not.toContain('min-h-[44px]');
  });

  it('supports English localization for image button labels and titles', () => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    render(
      <TerminalProvider>
        <KeyToolbar compact={false} />
      </TerminalProvider>
    );

    const btn = screen.getByTestId('image-upload-btn');
    expect(btn).toHaveAttribute('aria-label', 'Upload Image');
    expect(btn).toHaveAttribute('title', 'Select and upload image to terminal');
    expect(btn.textContent).toContain('Image');
  });

  it('clicking image button triggers native file input click', () => {
    setupTestSession('controller');

    const fileInput = screen.getByTestId('key-toolbar-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    const uploadBtn = screen.getByTestId('image-upload-btn');
    fireEvent.click(uploadBtn);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('viewer role clicking image button triggers warnViewerMode and does NOT open file input', () => {
    setupTestSession('viewer');

    const fileInput = screen.getByTestId('key-toolbar-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    const uploadBtn = screen.getByTestId('image-upload-btn');
    fireEvent.click(uploadBtn);

    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/观察者模式/i)).toBeInTheDocument();
  });

  it('selecting image executes compression and sends paste_file frame', async () => {
    const { getWs } = setupTestSession('controller');

    const fakeFile = new File(['fake-png-bytes'], 'chart.png', { type: 'image/png' });
    vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockResolvedValue({
      mime: 'image/webp',
      dataBase64: 'aGVsbG8=',
      dataUrl: 'data:image/webp;base64,aGVsbG8=',
      byteLength: 5,
      width: 800,
      height: 600,
    });

    const fileInput = screen.getByTestId('key-toolbar-file-input');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    await waitFor(() => {
      const lastWs = getWs();
      const pasteMsgs = lastWs.sent
        .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
        .filter((m) => m?.type === 'paste_file');
      expect(pasteMsgs.length).toBe(1);
      expect(pasteMsgs[0].mime).toBe('image/webp');
      expect(pasteMsgs[0].dataBase64).toBe('aGVsbG8=');
    });
  });

  it('allows selecting the exact same file twice by immediately clearing input value', async () => {
    const { getCtx } = setupTestSession('controller');

    const fakeFile = new File(['fake-png-bytes'], 'duplicate.png', { type: 'image/png' });
    const compressSpy = vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockResolvedValue({
      mime: 'image/webp',
      dataBase64: 'Y2hhcnQ=',
      dataUrl: 'data:image/webp;base64,Y2hhcnQ=',
      byteLength: 5,
      width: 600,
      height: 400,
    });

    const fileInput = screen.getByTestId('key-toolbar-file-input') as HTMLInputElement;

    // First selection
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    // Verify value was cleared immediately
    expect(fileInput.value).toBe('');
    expect(compressSpy).toHaveBeenCalledTimes(1);

    // Complete the first task to allow subsequent upload
    await act(async () => {
      getCtx()?.resetUploadProgress();
    });

    // Second selection of the exact same file
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    expect(fileInput.value).toBe('');
    expect(compressSpy).toHaveBeenCalledTimes(2);
  });

  it('displays honest phase progressbar, disables button during upload, and shows aria progress attributes', async () => {
    let resolveCompress: (val: any) => void = () => {};
    const compressPromise = new Promise((resolve) => {
      resolveCompress = resolve;
    });
    vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockImplementation(() => compressPromise as any);

    setupTestSession('controller');

    const fileInput = screen.getByTestId('key-toolbar-file-input');
    const fakeFile = new File(['fake-bytes'], 'test.png', { type: 'image/png' });

    // Initiate upload
    act(() => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    // 1. In processing phase:
    const uploadBtn = screen.getByTestId('image-upload-btn');
    expect(uploadBtn).toBeDisabled();

    const progressContainer = await screen.findByTestId('key-toolbar-progress');
    expect(progressContainer).toBeInTheDocument();

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toBeInTheDocument();
    expect(progressBar).toHaveAttribute('aria-valuemin', '0');
    expect(progressBar).toHaveAttribute('aria-valuemax', '100');
    expect(Number(progressBar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(10);
    expect(screen.getByText(/处理压缩中/)).toBeInTheDocument();

    // Resolve compression -> enters sending & waitingHost phase
    await act(async () => {
      resolveCompress({
        mime: 'image/webp',
        dataBase64: 'cHJvZ3Jlc3M=',
        dataUrl: 'data:image/webp;base64,cHJvZ3Jlc3M=',
        byteLength: 8,
        width: 100,
        height: 100,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/等待工作站保存/)).toBeInTheDocument();
    });
    const waitingBar = screen.getByRole('progressbar');
    expect(Number(waitingBar.getAttribute('aria-valuenow'))).toBe(88);
  });

  it('paste_file_ready transitions progress to 100% completed, pastes path into terminal, and resets to idle', async () => {
    vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockResolvedValue({
      mime: 'image/webp',
      dataBase64: 'ZmluaXNoZWQ=',
      dataUrl: 'data:image/webp;base64,ZmluaXNoZWQ=',
      byteLength: 8,
      width: 100,
      height: 100,
    });

    const { getCtx } = setupTestSession('controller');
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.paste = vi.fn();

    const fileInput = screen.getByTestId('key-toolbar-file-input');
    const fakeFile = new File(['fake-bytes'], 'done.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    await waitFor(() => {
      expect(screen.getByText(/等待工作站保存/)).toBeInTheDocument();
    });

    // Host connector sends paste_file_ready
    await act(async () => {
      emitAdapterEvent(getCtx(), 'pasteFileReady', '/tmp/pasted-test.webp');
    });

    // Verify terminal pasted host file path
    expect(term.paste).toHaveBeenCalledWith('/tmp/pasted-test.webp');

    // Verify 100% completed progress
    const completedBar = screen.getByRole('progressbar');
    expect(completedBar).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('完成')).toBeInTheDocument();

    // After completion duration (1200ms), progressbar resets and disappears
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300));
    });

    expect(screen.queryByTestId('key-toolbar-progress')).toBeNull();
    const btn = screen.getByTestId('image-upload-btn');
    expect(btn).not.toBeDisabled();
  });

  it('relay error event during upload resets progressbar and displays toast error', async () => {
    vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockResolvedValue({
      mime: 'image/webp',
      dataBase64: 'ZXJyb3I=',
      dataUrl: 'data:image/webp;base64,ZXJyb3I=',
      byteLength: 5,
      width: 100,
      height: 100,
    });

    const { getCtx } = setupTestSession('controller');

    const fileInput = screen.getByTestId('key-toolbar-file-input');
    const fakeFile = new File(['fake-bytes'], 'fail.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    await waitFor(() => {
      expect(screen.getByText(/等待工作站保存/)).toBeInTheDocument();
    });

    // Relay sends error (e.g. paste_file_too_large)
    await act(async () => {
      emitAdapterEvent(getCtx(), 'error', {
        code: 'paste_file_too_large',
        message: 'Pasted image exceeds 3 MB limit',
      });
    });

    // Progressbar resets immediately, does not hang
    expect(screen.queryByTestId('key-toolbar-progress')).toBeNull();
    const btn = screen.getByTestId('image-upload-btn');
    expect(btn).not.toBeDisabled();
    expect(await screen.findByText('粘贴图片超过 3 MB 上限。')).toBeInTheDocument();
  });

  it('per-window task isolation: paste_file_ready does NOT activate completion progress when this window did not initiate upload', async () => {
    const { getCtx } = setupTestSession('controller');
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.paste = vi.fn();

    // No upload was started by this window!
    // Another client or external event emits pasteFileReady
    await act(async () => {
      emitAdapterEvent(getCtx(), 'pasteFileReady', '/tmp/other-client.webp');
    });

    // TerminalView still pastes because it's a valid session event
    expect(term.paste).toHaveBeenCalledWith('/tmp/other-client.webp');

    // BUT this window's KeyToolbar progressbar was NOT activated!
    expect(screen.queryByTestId('key-toolbar-progress')).toBeNull();
  });

  it('collapsed toolbar shows handle and does NOT render standalone image upload button', () => {
    saveSettings({ toolbarVisible: false, language: 'zh' });
    let capturedCtx: ReturnType<typeof useTerminal> | null = null;
    const ContextCollector = () => {
      capturedCtx = useTerminal();
      return null;
    };

    render(
      <TerminalProvider>
        <ContextCollector />
        <KeyToolbar compact={false} />
      </TerminalProvider>
    );

    act(() => {
      emitAdapterEvent(capturedCtx, 'controlGranted');
    });

    const collapsedContainer = screen.getByTestId('key-toolbar-collapsed');
    expect(collapsedContainer).toBeInTheDocument();

    // Collapsed toolbar should only show expand handle, no standalone image button
    expect(screen.queryByTestId('image-upload-btn-collapsed')).toBeNull();
    expect(screen.queryByTestId('image-upload-btn')).toBeNull();

    // Can expand back to normal toolbar where image button appears
    const expandBtn = screen.getByRole('button', { name: /展开按键(条|栏)/i });
    fireEvent.click(expandBtn);

    expect(screen.getByTestId('key-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('image-upload-btn')).toBeInTheDocument();
  });

  it('keeps Enter as the right-hand key and collapse as the left-hand key without breaking toolbar key layout in desktop and compact modes', () => {
    // 1. Desktop mode
    saveSettings({ toolbarVisible: true, language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <KeyToolbar compact={false} />
      </TerminalProvider>
    );

    let row = screen.getByTestId('key-toolbar-row');
    let buttons = within(row).getAllByRole('button');

    // First button is collapse
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/收起按键|collapse/i));

    // Last button is Enter
    let last = buttons[buttons.length - 1];
    expect(last).toHaveAttribute('aria-label', expect.stringMatching(/回车|enter/i));

    // Image upload button sits right before Enter in the same row
    let imageBtn = buttons[buttons.length - 2];
    expect(imageBtn).toHaveAttribute('data-testid', 'image-upload-btn');
    expect(imageBtn).toHaveAttribute('aria-label', expect.stringMatching(/上传图片|Upload Image/i));
    expect(imageBtn.textContent).not.toContain('🖼️');
    expect(imageBtn.className).toContain('h-9');
    expect(imageBtn.className).not.toContain('min-h-[44px]');

    // Enter button also shares h-9 metric
    expect(last.className).toContain('h-9');

    unmount();

    // 2. Compact mode
    render(
      <TerminalProvider>
        <KeyToolbar compact={true} />
      </TerminalProvider>
    );

    row = screen.getByTestId('key-toolbar-row');
    buttons = within(row).getAllByRole('button');

    // First button is collapse
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/收起按键|collapse/i));

    // Last button is Enter
    last = buttons[buttons.length - 1];
    expect(last).toHaveAttribute('aria-label', expect.stringMatching(/回车|enter/i));

    // Image upload button sits right before Enter in compact row
    imageBtn = buttons[buttons.length - 2];
    expect(imageBtn).toHaveAttribute('data-testid', 'image-upload-btn');
    expect(imageBtn).toHaveAttribute('aria-label', expect.stringMatching(/上传图片|Upload Image/i));
    expect(imageBtn.textContent).not.toContain('🖼️');
    expect(imageBtn.className).toContain('h-9');
    expect(imageBtn.className).not.toContain('min-h-[44px]');
  });

  it('renders progress bar inside collapsed toolbar when upload is active', async () => {
    const { getCtx } = setupTestSession('controller', 'zh');
    const ctx = getCtx();
    act(() => {
      ctx?.updateSettings({ toolbarVisible: false });
    });

    expect(screen.getByTestId('key-toolbar-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('key-toolbar-progress-collapsed')).toBeNull();

    // Simulate active upload progress
    act(() => {
      ctx?.uploadImage(new File(['test-bytes'], 'test.png', { type: 'image/png' }));
    });

    expect(await screen.findByTestId('key-toolbar-progress-collapsed')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
