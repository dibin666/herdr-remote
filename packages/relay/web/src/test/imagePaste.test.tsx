import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  calculateScaledDimensions,
  getBase64ByteLength,
  formatByteSize,
  compressAndPrepareImage,
  MAX_PASTE_BYTES,
} from '../utils/imagePaste';
import * as imagePasteModule from '../utils/imagePaste';
import {
  readClipboardImage,
  extractImageFromClipboardEvent,
  extractImageFromFileList,
} from '../utils/clipboard';
import { PasteFallbackModal } from '../components/PasteFallbackModal';
import { ToastContainer } from '../components/ToastContainer';
import { TerminalView } from '../components/TerminalView';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

describe('imagePaste pipeline - unit tests', () => {
  it('calculates scaled dimensions correctly: 4000x3000 scaled down to max long edge 1568', () => {
    const scaled = calculateScaledDimensions(4000, 3000, 1568);
    expect(scaled.width).toBe(1568);
    expect(scaled.height).toBe(1176);
    expect(Math.max(scaled.width, scaled.height)).toBe(1568);

    // Height as longer edge
    const tall = calculateScaledDimensions(3000, 4000, 1568);
    expect(tall.width).toBe(1176);
    expect(tall.height).toBe(1568);

    // Smaller images are NEVER upscaled
    const small = calculateScaledDimensions(800, 600, 1568);
    expect(small.width).toBe(800);
    expect(small.height).toBe(600);
  });

  it('calculates exact decoded byte length from base64 strings with padding', () => {
    // Empty string
    expect(getBase64ByteLength('')).toBe(0);

    // "AAAA" -> 3 bytes, no padding
    expect(getBase64ByteLength('AAAA')).toBe(3);

    // "AAA=" -> 2 bytes, 1 padding
    expect(getBase64ByteLength('AAA=')).toBe(2);

    // "AA==" -> 1 byte, 2 padding
    expect(getBase64ByteLength('AA==')).toBe(1);
  });

  it('formats byte sizes cleanly for human readability in UI', () => {
    expect(formatByteSize(500)).toBe('500 B');
    expect(formatByteSize(1024)).toBe('1.0 KB');
    expect(formatByteSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  describe('compressAndPrepareImage', () => {
    const originalCreateImageBitmap = global.createImageBitmap;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

    afterEach(() => {
      global.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    });

    it('compresses a 4000x3000 image down to long edge 1568 and <= 3 MB payload', async () => {
      global.createImageBitmap = vi.fn().mockResolvedValue({
        width: 4000,
        height: 3000,
        close: vi.fn(),
      } as unknown as ImageBitmap);

      const mockCtx = {
        drawImage: vi.fn(),
      };
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

      // Generate a valid mock data URL (~100 KB payload)
      const fakeBase64 = 'A'.repeat(100 * 1024);
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockImplementation((mime: string) => {
        return `data:${mime};base64,${fakeBase64}`;
      });

      const fakeBlob = new Blob(['dummy-image-data'], { type: 'image/png' });
      const result = await compressAndPrepareImage(fakeBlob);

      expect(result).not.toBeNull();
      expect(result?.width).toBe(1568);
      expect(result?.height).toBe(1176);
      expect(result?.byteLength).toBeLessThanOrEqual(MAX_PASTE_BYTES);
      expect(result?.dataUrl.startsWith('data:')).toBe(true);
      expect(result?.mime).toBe('image/webp');
    });

    it('falls back to image/jpeg if canvas does not support image/webp export', async () => {
      global.createImageBitmap = vi.fn().mockResolvedValue({
        width: 800,
        height: 600,
        close: vi.fn(),
      } as unknown as ImageBitmap);

      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });

      // When asked for image/webp, pretend browser does not support it and returns image/png
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockImplementation((mime: string) => {
        if (mime === 'image/webp') {
          return 'data:image/png;base64,AAAA';
        }
        return `data:${mime};base64,AAAA`;
      });

      const fakeBlob = new Blob(['dummy'], { type: 'image/jpeg' });
      const result = await compressAndPrepareImage(fakeBlob);

      expect(result).not.toBeNull();
      expect(result?.mime).toBe('image/jpeg');
    });

    it('steps down quality and rejects oversized payload when all quality tiers exceed 3 MB (压不下去不发送)', async () => {
      global.createImageBitmap = vi.fn().mockResolvedValue({
        width: 4000,
        height: 3000,
        close: vi.fn(),
      } as unknown as ImageBitmap);

      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });

      // Generate a mock base64 payload larger than 3 MB (~4 MB raw bytes)
      const oversizedBase64 = 'A'.repeat(5 * 1024 * 1024);
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue(`data:image/webp;base64,${oversizedBase64}`);

      const fakeBlob = new Blob(['dummy'], { type: 'image/png' });
      const result = await compressAndPrepareImage(fakeBlob);

      // Must return null, indicating compression failure so caller refuses to send
      expect(result).toBeNull();
    });

    it('decodes image with EXIF imageOrientation: "from-image"', async () => {
      const createBitmapSpy = vi.fn().mockResolvedValue({
        width: 800,
        height: 600,
        close: vi.fn(),
      } as unknown as ImageBitmap);
      global.createImageBitmap = createBitmapSpy;
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,AAAA');

      const fakeBlob = new Blob(['dummy'], { type: 'image/jpeg' });
      await compressAndPrepareImage(fakeBlob);
      expect(createBitmapSpy).toHaveBeenCalledWith(fakeBlob, { imageOrientation: 'from-image' });
    });

    it('rejects empty blob with size 0', async () => {
      const emptyBlob = new Blob([], { type: 'image/png' });
      const res = await compressAndPrepareImage(emptyBlob);
      expect(res).toBeNull();
    });

    it('rejects non-image blob', async () => {
      const textBlob = new Blob(['not an image'], { type: 'text/plain' });
      const res = await compressAndPrepareImage(textBlob);
      expect(res).toBeNull();
    });
  });
});

describe('clipboard image extraction paths (Requirement C1)', () => {
  it('Path 1: readClipboardImage() retrieves image Blob via navigator.clipboard.read()', async () => {
    const fakeImageBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const mockItem = {
      types: ['text/plain', 'image/png'],
      getType: vi.fn(async (t: string) => (t === 'image/png' ? fakeImageBlob : new Blob())),
    };

    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: {
        read: vi.fn().mockResolvedValue([mockItem]),
      },
    });

    const result = await readClipboardImage();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob).toBe(fakeImageBlob);
    }

    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: originalClipboard,
    });
  });

  it('Path 2: extractImageFromClipboardEvent() extracts image Blob from event files and items', () => {
    const fakeFile = new File(['fake-png'], 'test.png', { type: 'image/png' });

    // 2a. files collection
    const eventWithFiles = {
      clipboardData: {
        files: [fakeFile],
        items: [],
      } as unknown as DataTransfer,
    };
    expect(extractImageFromClipboardEvent(eventWithFiles)).toBe(fakeFile);

    // 2b. items collection
    const eventWithItems = {
      clipboardData: {
        files: [],
        items: [
          {
            type: 'image/jpeg',
            getAsFile: () => fakeFile,
          },
        ],
      } as unknown as DataTransfer,
    };
    expect(extractImageFromClipboardEvent(eventWithItems)).toBe(fakeFile);

    // 2c. text only
    const eventWithText = {
      clipboardData: {
        files: [],
        items: [
          {
            type: 'text/plain',
            getAsFile: () => null,
          },
        ],
      } as unknown as DataTransfer,
    };
    expect(extractImageFromClipboardEvent(eventWithText)).toBeNull();
  });

  it('Path 3: extractImageFromFileList() extracts image File from input file list', () => {
    const fakeFile = new File(['fake-jpg'], 'photo.jpg', { type: 'image/jpeg' });
    const fakeTextFile = new File(['text'], 'notes.txt', { type: 'text/plain' });

    const fileList = [fakeTextFile, fakeFile] as unknown as FileList;
    expect(extractImageFromFileList(fileList)).toBe(fakeFile);

    const emptyList = [] as unknown as FileList;
    expect(extractImageFromFileList(emptyList)).toBeNull();
  });
});

describe('PasteFallbackModal - CSP and Image preview (Requirement C2 & C5)', () => {
  beforeEach(() => {
    saveSettings({ language: 'zh' });
  });

  it('renders preview with data: URL (NEVER blob: URL) when image is loaded', async () => {
    const onSend = vi.fn();
    const onSendImage = vi.fn();

    render(
      <TerminalProvider>
        <PasteFallbackModal
          isOpen={true}
          onClose={vi.fn()}
          onSend={onSend}
          onSendImage={onSendImage}
        />
      </TerminalProvider>
    );

    const fileInput = screen.getByTestId('paste-fallback-file-input');
    const fakeFile = new File(['fake-image-bytes'], 'screenshot.png', { type: 'image/png' });

    // Mock compressAndPrepareImage for this test
    global.createImageBitmap = vi.fn().mockResolvedValue({
      width: 1000,
      height: 800,
      close: vi.fn(),
    } as unknown as ImageBitmap);

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,AQIDBA==');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });

    const previewImg = await screen.findByTestId('pasted-image-preview');
    expect(previewImg).toBeInTheDocument();

    const src = previewImg.getAttribute('src');
    // STRICT CSP ASSERTION: must start with data:, never blob:
    expect(src).toMatch(/^data:image\/webp;base64,/);
    expect(src?.startsWith('blob:')).toBe(false);

    // Send button must now be active
    const sendBtn = screen.getByRole('button', { name: '发送' });
    expect(sendBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(sendBtn);
    });

    expect(onSendImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: 'image/webp',
        dataBase64: 'AQIDBA==',
      })
    );
  });

  it('triggers camera input with capture="environment" when 拍照 button is clicked', async () => {
    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={true} onClose={vi.fn()} onSend={vi.fn()} />
      </TerminalProvider>
    );

    const cameraInput = screen.getByTestId('paste-fallback-camera-input');
    expect(cameraInput).toBeInTheDocument();
    expect(cameraInput.getAttribute('capture')).toBe('environment');

    const cameraClickSpy = vi.spyOn(cameraInput, 'click');
    const photoBtn = screen.getByRole('button', { name: '拍照' });
    fireEvent.click(photoBtn);
    expect(cameraClickSpy).toHaveBeenCalledTimes(1);
  });

  it('allows selecting the exact same file twice by clearing input value', async () => {
    global.createImageBitmap = vi.fn().mockResolvedValue({
      width: 1000,
      height: 800,
      close: vi.fn(),
    } as unknown as ImageBitmap);
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,AAAA');

    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={true} onClose={vi.fn()} onSend={vi.fn()} />
      </TerminalProvider>
    );

    const fileInput = screen.getByTestId('paste-fallback-file-input') as HTMLInputElement;
    const fakeFile = new File(['bytes'], 'same.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });
    expect(await screen.findByTestId('pasted-image-preview')).toBeInTheDocument();
    // Value should have been reset to empty string
    expect(fileInput.value).toBe('');

    // Cancel image preview
    const cancelImgBtn = screen.getByRole('button', { name: '移除图片' });
    fireEvent.click(cancelImgBtn);
    expect(screen.queryByTestId('pasted-image-preview')).toBeNull();

    // Select the exact same file again
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    });
    expect(await screen.findByTestId('pasted-image-preview')).toBeInTheDocument();
  });

  it('rejects empty file with toast and does not enable send button', async () => {
    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={true} onClose={vi.fn()} onSend={vi.fn()} />
        <ToastContainer />
      </TerminalProvider>
    );

    const fileInput = screen.getByTestId('paste-fallback-file-input');
    const emptyFile = new File([], 'empty.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [emptyFile] } });
    });

    expect(await screen.findByText('文件内容为空。')).toBeInTheDocument();
    expect(screen.queryByTestId('pasted-image-preview')).toBeNull();
    const sendBtn = screen.getByRole('button', { name: '发送' });
    expect(sendBtn).toBeDisabled();
  });

  it('handles image paste event directly on textarea in modal', async () => {
    global.createImageBitmap = vi.fn().mockResolvedValue({
      width: 500,
      height: 400,
      close: vi.fn(),
    } as unknown as ImageBitmap);
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,AAAA');

    render(
      <TerminalProvider>
        <PasteFallbackModal isOpen={true} onClose={vi.fn()} onSend={vi.fn()} />
      </TerminalProvider>
    );

    const textarea = screen.getByTestId('paste-fallback-input');
    const fakeImageFile = new File(['fake-png'], 'clipboard.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [fakeImageFile],
          items: [],
        },
      });
    });

    expect(await screen.findByTestId('pasted-image-preview')).toBeInTheDocument();
  });
});

describe('TerminalView image paste integration (End-to-End)', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    vi.restoreAllMocks();

    saveSettings({ language: 'zh' });

    window.matchMedia = ((query: string) => ({
      matches: /pointer:\s*coarse|hover:\s*none/.test(query),
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

  it('receives paste_file_ready and executes term.paste(path) with host file path', async () => {
    let capturedAdapter: any = null;
    const CaptureAdapter = () => {
      const { adapter } = useTerminal();
      capturedAdapter = adapter;
      return null;
    };

    render(
      <TerminalProvider>
        <CaptureAdapter />
        <TerminalView isActive={true} />
        <ToastContainer />
      </TerminalProvider>
    );

    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    expect(term).toBeDefined();
    term.paste = vi.fn();

    expect(capturedAdapter).not.toBeNull();

    // Host sends paste_file_ready
    await act(async () => {
      capturedAdapter.emit('pasteFileReady', '/home/user/.local/state/herdr-remote/pasted/generated-uuid.webp');
    });

    expect(term.paste).toHaveBeenCalledWith(
      '/home/user/.local/state/herdr-remote/pasted/generated-uuid.webp'
    );
    expect(await screen.findByText('已粘贴')).toBeInTheDocument();
  });

  it('rejects uncompressable oversized images without sending over websocket (防掉线断言)', async () => {
    // Mock navigator.clipboard.read returning an image
    const fakeBlob = new Blob(['oversized'], { type: 'image/png' });
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ['image/png'],
            getType: vi.fn().mockResolvedValue(fakeBlob),
          },
        ]),
      },
    });

    // Mock compress pipeline returning null (failed compression / still exceeds 3 MB)
    vi.spyOn(imagePasteModule, 'compressAndPrepareImage').mockResolvedValue(null);

    let capturedCtx: any = null;
    const CaptureContext = () => {
      capturedCtx = useTerminal();
      return null;
    };

    render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
        <ToastContainer />
      </TerminalProvider>
    );

    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    term.paste = vi.fn();

    const lastWs = webSocketInstances[webSocketInstances.length - 1];
    act(() => {
      lastWs.simulateOpen();
      capturedCtx?.adapter?.emit('sessionReady', {});
    });

    // Give control so paste option appears in menu
    act(() => {
      capturedCtx?.adapter?.emit('controlGranted');
    });

    // Trigger long press gesture to open selection menu
    const container = document.querySelector('#terminal-container') as HTMLElement;
    expect(container).not.toBeNull();

    act(() => {
      container.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 100,
          clientY: 100,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });

    act(() => {
      container.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 100,
          clientY: 100,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    const pasteAction = await screen.findByRole('menuitem', { name: /粘贴/i });
    await act(async () => {
      fireEvent.click(pasteAction);
    });

    // CRITICAL ASSERTION: No paste_file frame was sent over WebSocket because image was oversized
    if (lastWs) {
      const pasteFileMessages = lastWs.sent
        .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
        .filter((msg) => msg?.type === 'paste_file');
      expect(pasteFileMessages.length).toBe(0);
    }

    // Toast indicates rejection
    expect(await screen.findByText('图片超过 3 MB 限制且无法进一步压缩。')).toBeInTheDocument();
  });

  it('viewer role clicking paste calls warnViewerMode and does NOT send anything', async () => {
    let capturedCtx: any = null;
    const CaptureContext = () => {
      capturedCtx = useTerminal();
      return null;
    };

    render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );

    // Ensure role is viewer
    await act(async () => {
      capturedCtx.releaseControl();
    });

    const lastWs = webSocketInstances[webSocketInstances.length - 1];

    // Trigger long press to pop menu
    const surface = document.querySelector('.terminal-container') || document.body;
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    surface.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    }));

    // In viewer mode, menu does not show paste action (it is filtered out)
    expect(screen.queryByText('粘贴')).toBeNull();

    // Direct invocation of sendPasteFile also refuses and warns viewer mode
    const sendResult = capturedCtx.sendPasteFile('image/png', 'AAAA');
    expect(sendResult).toBe(false);

    if (lastWs) {
      const pasteFileMessages = lastWs.sent
        .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
        .filter((msg) => msg?.type === 'paste_file');
      expect(pasteFileMessages.length).toBe(0);
    }
  });

  it('handles desktop paste event on terminal containing image by sending paste file', async () => {
    let capturedCtx: any = null;
    const CaptureContext = () => {
      capturedCtx = useTerminal();
      return null;
    };

    render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );

    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const lastWs = webSocketInstances[webSocketInstances.length - 1];
    act(() => {
      lastWs.simulateOpen();
      // A real image upload is only allowed after the terminal session is ready.
      capturedCtx?.adapter?.emit('sessionReady', {});
    });

    act(() => {
      capturedCtx?.adapter?.emit('controlGranted');
    });
    await waitFor(() => expect(capturedCtx?.isController).toBe(true));

    const fakeImageFile = new File(['fake-png-bytes'], 'screenshot.png', { type: 'image/png' });
    global.createImageBitmap = vi.fn().mockResolvedValue({
      width: 1000,
      height: 800,
      close: vi.fn(),
    } as unknown as ImageBitmap);
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() });
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/webp;base64,AQIDBA==');

    const container = document.querySelector('#terminal-container') as HTMLElement;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [fakeImageFile],
        items: [],
      },
    });

    const preventDefaultSpy = vi.spyOn(pasteEvent, 'preventDefault');

    await act(async () => {
      container.dispatchEvent(pasteEvent);
    });

    expect(preventDefaultSpy).toHaveBeenCalled();
    await waitFor(() => {
      const lastWs = webSocketInstances[webSocketInstances.length - 1];
      const pasteFileMessages = lastWs.sent
        .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
        .filter((msg) => msg?.type === 'paste_file');
      expect(pasteFileMessages.length).toBe(1);
      expect(pasteFileMessages[0].mime).toBe('image/webp');
      expect(pasteFileMessages[0].dataBase64).toBe('AQIDBA==');
    });
  });

  it('leaves plain text paste event untouched on desktop terminal', async () => {
    let capturedCtx: any = null;
    const CaptureContext = () => {
      capturedCtx = useTerminal();
      return null;
    };

    render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );

    await waitFor(() => expect(xtermInstances.length).toBe(1));

    act(() => {
      capturedCtx?.adapter?.emit('controlGranted');
    });

    const container = document.querySelector('#terminal-container') as HTMLElement;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [],
        items: [{ type: 'text/plain', getAsFile: () => null }],
      },
    });

    const preventDefaultSpy = vi.spyOn(pasteEvent, 'preventDefault');

    await act(async () => {
      container.dispatchEvent(pasteEvent);
    });

    // Default paste must NOT be prevented, allowing xterm text paste to proceed
    expect(preventDefaultSpy).not.toHaveBeenCalled();
    const lastWs = webSocketInstances[webSocketInstances.length - 1];
    const pasteFileMessages = lastWs.sent
      .map((s) => (typeof s === 'string' ? JSON.parse(s) : null))
      .filter((msg) => msg?.type === 'paste_file');
    expect(pasteFileMessages.length).toBe(0);
});
});
