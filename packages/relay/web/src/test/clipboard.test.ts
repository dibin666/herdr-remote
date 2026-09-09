import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText, readClipboardText } from '../utils/clipboard';

describe('clipboard utils', () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    document.execCommand = originalExecCommand;
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
      writable: true,
    });
  });

  describe('copyText', () => {
    it('uses navigator.clipboard.writeText when available and returns "clipboard"', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
        writable: true,
      });

      const result = await copyText('test text');
      expect(result).toBe('clipboard');
      expect(writeTextMock).toHaveBeenCalledWith('test text');
    });

    it('falls back to execCommand when navigator.clipboard.writeText throws', async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
        writable: true,
      });

      const execMock = vi.fn().mockReturnValue(true);
      document.execCommand = execMock;

      const result = await copyText('fallback text');
      expect(result).toBe('exec');
      expect(writeTextMock).toHaveBeenCalledWith('fallback text');
      expect(execMock).toHaveBeenCalledWith('copy');
    });

    it('falls back to execCommand when navigator.clipboard is undefined (HTTP LAN access)', async () => {
      // Insecure HTTP origin stripped navigator.clipboard
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      let textareaFoundInDOM = false;
      let userSelectStyle = '';
      let webkitUserSelectStyle = '';
      let positionStyle = '';
      let opacityStyle = '';

      const execMock = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'copy') {
          const ta = document.querySelector('textarea');
          if (ta) {
            textareaFoundInDOM = true;
            userSelectStyle = ta.style.userSelect;
            webkitUserSelectStyle = ta.style.webkitUserSelect;
            positionStyle = ta.style.position;
            opacityStyle = ta.style.opacity;
          }
          return true;
        }
        return false;
      });
      document.execCommand = execMock;

      const result = await copyText('lan-http-copy');
      expect(result).toBe('exec');
      expect(execMock).toHaveBeenCalledWith('copy');

      // Crucial requirement: textarea must explicitly set user-select: text to counteract App.tsx:229 select-none
      expect(textareaFoundInDOM).toBe(true);
      expect(userSelectStyle).toBe('text');
      expect(webkitUserSelectStyle).toBe('text');

      // Crucial requirement: position fixed 0,0 opacity 0 without jumping viewport
      expect(positionStyle).toBe('fixed');
      expect(opacityStyle).toBe('0');

      // Must be cleaned up after execution
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('handles iOS Safari selection using DOM Range and setSelectionRange', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      // Simulate iPhone Safari user agent
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
        writable: true,
      });

      const createRangeSpy = vi.spyOn(document, 'createRange');
      const execMock = vi.fn().mockReturnValue(true);
      document.execCommand = execMock;

      const result = await copyText('ios copy text');
      expect(result).toBe('exec');
      expect(createRangeSpy).toHaveBeenCalled();
      expect(execMock).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('returns "failed" when both clipboard API and execCommand fail', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      document.execCommand = vi.fn().mockReturnValue(false);

      const result = await copyText('will fail');
      expect(result).toBe('failed');
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('returns "failed" when execCommand throws an error', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      document.execCommand = vi.fn().mockImplementation(() => {
        throw new Error('Blocked by security policy');
      });

      const result = await copyText('throws error');
      expect(result).toBe('failed');
      expect(document.querySelector('textarea')).toBeNull();
    });
  });

  describe('readClipboardText', () => {
    it('reads text successfully via navigator.clipboard.readText', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: vi.fn().mockResolvedValue('hello from clipboard'),
        },
        configurable: true,
        writable: true,
      });

      const result = await readClipboardText();
      expect(result).toEqual({ ok: true, text: 'hello from clipboard' });
    });

    it('returns reason "empty" when clipboard returns an empty string', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: vi.fn().mockResolvedValue(''),
        },
        configurable: true,
        writable: true,
      });

      const result = await readClipboardText();
      expect(result).toEqual({ ok: false, reason: 'empty' });
    });

    it('returns reason "insecure" when window.isSecureContext is false', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: vi.fn().mockResolvedValue('text'),
        },
        configurable: true,
        writable: true,
      });

      const result = await readClipboardText();
      expect(result).toEqual({ ok: false, reason: 'insecure' });
    });

    it('returns reason "insecure" when navigator.clipboard is missing', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const result = await readClipboardText();
      expect(result).toEqual({ ok: false, reason: 'insecure' });
    });

    it('returns reason "denied" when readText throws NotAllowedError', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
        writable: true,
      });
      const error = new Error('Permission denied');
      error.name = 'NotAllowedError';
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: vi.fn().mockRejectedValue(error),
        },
        configurable: true,
        writable: true,
      });

      const result = await readClipboardText();
      expect(result).toEqual({ ok: false, reason: 'denied' });
    });

    it('never invokes execCommand("paste")', async () => {
      const execMock = vi.fn();
      document.execCommand = execMock;

      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      await readClipboardText();
      expect(execMock).not.toHaveBeenCalled();
    });
  });
});
