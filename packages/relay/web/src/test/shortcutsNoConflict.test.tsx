import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isEventFromTerminal, isEventFromFormInput, attachWebUIShortcuts } from '../utils/shortcuts';

describe('WebUI Shortcuts Non-Conflict Isolation & Safety', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects events originating inside #terminal-container or .xterm', () => {
    const container = document.createElement('div');
    container.id = 'terminal-container';
    const xtermArea = document.createElement('textarea');
    xtermArea.className = 'xterm-helper-textarea';
    container.appendChild(xtermArea);
    document.body.appendChild(container);

    const eventInTerminal = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
    });
    Object.defineProperty(eventInTerminal, 'target', { value: xtermArea });

    expect(isEventFromTerminal(eventInTerminal)).toBe(true);

    const externalButton = document.createElement('button');
    document.body.appendChild(externalButton);

    const eventOutsideTerminal = new KeyboardEvent('keydown', {
      key: 's',
      altKey: true,
      shiftKey: true,
      bubbles: true,
    });
    Object.defineProperty(eventOutsideTerminal, 'target', { value: externalButton });

    expect(isEventFromTerminal(eventOutsideTerminal)).toBe(false);
  });

  it('detects form input elements outside terminal', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const inputEvent = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(inputEvent, 'target', { value: input });
    expect(isEventFromFormInput(inputEvent)).toBe(true);

    const termArea = document.createElement('textarea');
    termArea.className = 'xterm-helper-textarea';
    document.body.appendChild(termArea);

    const termEvent = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(termEvent, 'target', { value: termArea });
    expect(isEventFromFormInput(termEvent)).toBe(false);
  });

  it('STRICTLY NEVER prevents default or stops propagation on Ctrl, Alt, Meta, Zoom, or Alt+Shift chords', () => {
    const actions = {
      onCloseModals: vi.fn(),
    };

    const cleanup = attachWebUIShortcuts(actions, { isModalOpen: true });

    // Exhaustive list of modifier chords:
    // - Browser zoom: Ctrl +, Ctrl -, Ctrl 0
    // - Herdr multiplexer: Ctrl+B, Alt+1-9, Alt+Arrow
    // - Standard terminal chords: Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+A, Ctrl+E, Ctrl+L, Ctrl+K
    // - Meta chords: Meta+C, Meta+V, Meta+R
    // - Alt+Shift chords: Alt+Shift+S, Alt+Shift+P, Alt+Shift+A
    const chordsToTest = [
      { key: '+', ctrlKey: true },
      { key: '-', ctrlKey: true },
      { key: '0', ctrlKey: true },
      { key: '=', ctrlKey: true },
      { key: 'b', ctrlKey: true },
      { key: 'c', ctrlKey: true },
      { key: 'd', ctrlKey: true },
      { key: 'z', ctrlKey: true },
      { key: '1', altKey: true },
      { key: '2', altKey: true },
      { key: 'ArrowRight', altKey: true },
      { key: 'r', metaKey: true },
      { key: 's', altKey: true, shiftKey: true },
      { key: 'p', altKey: true, shiftKey: true },
      { key: 'a', altKey: true, shiftKey: true },
      { key: 'l', altKey: true, shiftKey: true },
      { key: 'k', altKey: true, shiftKey: true },
    ];

    const targetEl = document.createElement('div');
    document.body.appendChild(targetEl);

    for (const chord of chordsToTest) {
      const event = new KeyboardEvent('keydown', {
        ...chord,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'target', { value: targetEl });

      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      window.dispatchEvent(event);

      // Verify: NO handler prevented default or stopped propagation
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(stopPropagationSpy).not.toHaveBeenCalled();
      expect(actions.onCloseModals).not.toHaveBeenCalled();
    }

    cleanup();
  });

  it('closes open modals only on Escape pressed outside the terminal', () => {
    const actions = {
      onCloseModals: vi.fn(),
    };

    const cleanup = attachWebUIShortcuts(actions, { isModalOpen: true });

    const modalDialog = document.createElement('div');
    modalDialog.setAttribute('role', 'dialog');
    document.body.appendChild(modalDialog);

    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(escEvent, 'target', { value: modalDialog });

    const preventDefaultSpy = vi.spyOn(escEvent, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(escEvent, 'stopPropagation');

    window.dispatchEvent(escEvent);

    expect(actions.onCloseModals).toHaveBeenCalledTimes(1);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();

    cleanup();
  });

  it('does NOT close modals on Escape if the event is focused inside the terminal', () => {
    const container = document.createElement('div');
    container.id = 'terminal-container';
    document.body.appendChild(container);

    const actions = {
      onCloseModals: vi.fn(),
    };

    const cleanup = attachWebUIShortcuts(actions, { isModalOpen: true });

    const escEventInTerm = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(escEventInTerm, 'target', { value: container });

    const preventDefaultSpy = vi.spyOn(escEventInTerm, 'preventDefault');
    window.dispatchEvent(escEventInTerm);

    // Escape inside terminal passes to PTY without closing modals or preventing default
    expect(actions.onCloseModals).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();

    cleanup();
  });
});
