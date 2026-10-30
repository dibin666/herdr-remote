import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachLinkClickBridge } from './terminalLinks';

/**
 * A Ctrl/Cmd-click on a link opens it in this browser and nowhere else: the
 * press never reaches the PTY, and the release does not open it twice.
 */

const LINK = 'https://example.com/x';

/** The cell every click below lands on: column 6, first row, 10px squares. */
const CELL = { clientX: 65, clientY: 15 };

function clickAt(
  element: HTMLElement,
  type: 'mousedown' | 'mouseup',
  init: MouseEventInit = {},
): void {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...CELL, ...init }),
  );
}

/**
 * A terminal where `linkifier` hovers `link` over the first row's middle, in
 * a DOM under `container`. `_core` carries the private pieces the bridge
 * reads, shaped exactly the way xterm keeps them.
 */
function linkTerm(container: HTMLElement, link: unknown) {
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  element.appendChild(screen);
  container.appendChild(element);
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 480,
    width: 800,
    height: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const term = {
    cols: 80,
    rows: 24,
    element,
    focus: vi.fn(),
    buffer: { active: { viewportY: 0, getLine: () => undefined } },
    _core: {
      linkifier: { currentLink: link },
      _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } },
    },
  } as unknown as Terminal;
  return { term, element };
}

/** The buffer-backed fallback: a line with the URL the bridge scans itself. */
function textTerm(container: HTMLElement) {
  const { term, element } = linkTerm(container, null);
  const buffer = {
    active: {
      viewportY: 0,
      getLine: (row: number) =>
        row === 0
          ? {
              isWrapped: false,
              translateToString: () => `open ${LINK} here`,
            }
          : undefined,
    },
  };
  Object.defineProperty(term, 'buffer', { value: buffer, configurable: true });
  return { term, element };
}

describe('a Ctrl/Cmd-click on a link', () => {
  let open: ReturnType<typeof vi.fn>;
  let container: HTMLElement;
  beforeEach(() => {
    open = vi.fn();
    vi.stubGlobal('open', open);
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    container.remove();
  });

  it('opens the linkifier link here and lets the press reach nothing else', () => {
    const link = {
      link: { text: LINK, range: { start: { x: 6, y: 1 }, end: { x: 26, y: 1 } } },
    };
    const { term, element } = linkTerm(container, link);
    const detach = attachLinkClickBridge(container, term);
    const inner = vi.fn();
    element.addEventListener('mousedown', inner);
    element.addEventListener('mouseup', inner);

    clickAt(element, 'mousedown', { ctrlKey: true });
    clickAt(element, 'mouseup', { ctrlKey: true });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LINK, '_blank', 'noopener,noreferrer');
    expect(inner).not.toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
    detach();
  });

  it('finds a buffer URL the linkifier did not detect', () => {
    const { term, element } = textTerm(container);
    const detach = attachLinkClickBridge(container, term);
    const inner = vi.fn();
    element.addEventListener('mousedown', inner);

    // The URL starts at column 5 in `open <url> here`; the click lands inside.
    clickAt(element, 'mousedown', { metaKey: true, clientX: 95 });

    expect(open).toHaveBeenCalledWith(LINK, '_blank', 'noopener,noreferrer');
    expect(inner).not.toHaveBeenCalled();
    detach();
  });

  it('leaves every other press to the terminal', () => {
    const link = {
      link: { text: LINK, range: { start: { x: 6, y: 1 }, end: { x: 26, y: 1 } } },
    };
    const { term, element } = linkTerm(container, link);
    const detach = attachLinkClickBridge(container, term);
    const inner = vi.fn();
    element.addEventListener('mousedown', inner);

    // Plain click, Shift-click for selection, Alt-click, a click off the link.
    for (const init of [
      {},
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, clientX: 300 },
      { ctrlKey: true, button: 2 },
    ]) {
      clickAt(element, 'mousedown', init);
    }

    expect(open).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(5);
    detach();
  });

  it('does not swallow a scheme the browser may not open', () => {
    const link = {
      link: {
        text: 'javascript:alert(1)',
        range: { start: { x: 6, y: 1 }, end: { x: 26, y: 1 } },
      },
    };
    const { term, element } = linkTerm(container, link);
    const detach = attachLinkClickBridge(container, term);
    const inner = vi.fn();
    element.addEventListener('mousedown', inner);

    clickAt(element, 'mousedown', { ctrlKey: true });

    expect(open).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    detach();
  });
});
