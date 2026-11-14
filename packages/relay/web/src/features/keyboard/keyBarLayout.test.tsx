import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KeyToolbar } from './KeyToolbar';
import { MobileControlSheet } from '@/features/mobile/MobileControlSheet';
import { TerminalProvider } from '@/context/TerminalContext';
import { loadSettings, saveSettings } from '@/features/settings/storage';
import { ALL_AVAILABLE_KEYS, DEFAULT_TOOLBAR_KEYS, sanitizeVirtualKeys } from './virtualKeys';

/**
 * Where the touch keys sit, and what language the chrome speaks.
 *
 * Both were reported as defects against the same row of the screen: Enter was
 * buried in the middle of the bar with a collapse control taking the right-hand
 * end, the Fn drawer's arrow pointed sideways at nothing, and the commands on
 * the header stayed English on a Chinese interface.
 */
describe('Touch key bar layout', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const renderToolbar = (compact = false) => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    return render(
      <TerminalProvider>
        <KeyToolbar compact={compact} />
      </TerminalProvider>,
    );
  };

  it('ends the default bar with Enter, where a keyboard puts it', () => {
    expect(DEFAULT_TOOLBAR_KEYS[DEFAULT_TOOLBAR_KEYS.length - 1].id).toBe('enter');
    expect(DEFAULT_TOOLBAR_KEYS.map((key) => key.id)).toEqual([
      'esc',
      'tab',
      'ctrl',
      'alt',
      'left',
      'up',
      'down',
      'right',
      'drawer_symbols',
      'drawer_fn',
      'enter',
    ]);
  });

  it('puts Enter at the right-hand end of the rendered row', () => {
    renderToolbar();

    const row = screen.getByTestId('key-toolbar-row');
    const buttons = within(row).getAllByRole('button');
    const last = buttons[buttons.length - 1];

    expect(last).toHaveAttribute('aria-label', expect.stringMatching(/enter/i));
    // The bar has no collapse cap: hiding it belongs to the sheet and
    // settings, not to a key a thumb can hit mid-session.
    expect(within(row).queryByRole('button', { name: /collapse|收起按键/i })).toBeNull();
  });

  it('points the Fn arrow at the drawer, which opens upwards', () => {
    renderToolbar();

    const fn = screen.getByRole('button', { name: /function keys/i });
    expect(fn.textContent).toContain('\u{F0360}'); // nf-md-menu_up

    fireEvent.click(fn);
    expect(screen.getByRole('button', { name: /function keys/i }).textContent).toContain(
      '\u{F035D}', // nf-md-menu_down
    );
    expect(screen.getByRole('button', { name: 'F7' })).toBeInTheDocument();
  });

  it('upgrades an untouched saved layout to the new default order', () => {
    // The previous shipped default had a dedicated Shift+Tab and Ctrl drawer.
    const byId = new Map(ALL_AVAILABLE_KEYS.map((key) => [key.id, key]));
    const legacy = [
      'esc',
      'tab',
      'shift_tab',
      'ctrl',
      'alt',
      'left',
      'up',
      'down',
      'right',
      'drawer_chords',
      'drawer_symbols',
      'drawer_fn',
      'enter',
    ].map((id) => byId.get(id)!);

    const upgraded = sanitizeVirtualKeys(legacy);
    expect(upgraded.map((key) => key.id)).toEqual(DEFAULT_TOOLBAR_KEYS.map((key) => key.id));

    const oldestLegacy = [
      'esc',
      'tab',
      'ctrl',
      'alt',
      'left',
      'up',
      'down',
      'right',
      'enter',
      'drawer_chords',
      'drawer_symbols',
      'drawer_fn',
    ].map((id) => byId.get(id)!);
    expect(sanitizeVirtualKeys(oldestLegacy).map((key) => key.id)).toEqual(
      DEFAULT_TOOLBAR_KEYS.map((key) => key.id),
    );

    // A layout the user actually arranged is left exactly as they left it.
    const custom = [legacy[0], legacy[1]];
    expect(sanitizeVirtualKeys(custom).map((key) => key.id)).toEqual(custom.map((key) => key.id));
  });

  it('keeps base, agent and file keys in one continuous phone strip without a pager row', () => {
    renderToolbar(true);

    const strip = screen.getByTestId('key-toolbar-scroll');
    expect(within(strip).getByRole('button', { name: /esc/i })).toBeInTheDocument();
    expect(strip).toContainElement(screen.getByTestId('agent-key-actions'));
    expect(strip).toContainElement(screen.getByTestId('file-upload-btn'));
    expect(strip).toContainElement(screen.getByTestId('file-list-btn'));
    expect(screen.queryByTestId('key-toolbar-pages')).toBeNull();
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).toContain('touch-pan-x');
    expect(strip.className).toContain('[-webkit-overflow-scrolling:touch]');
    expect(strip.className).not.toMatch(/\bsnap-/);
  });

  it.each([
    { direction: 'left', scrollLeft: 760, startX: 240, endX: 80 },
    { direction: 'right', scrollLeft: 3, startX: 80, endX: 240 },
  ])(
    'preserves the native scroll position and key contents after a $direction edge swipe',
    ({ scrollLeft, startX, endX }) => {
      renderToolbar(true);

      const strip = screen.getByTestId('key-toolbar-scroll');
      const keys = within(strip)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'));
      Object.defineProperties(strip, {
        clientWidth: { configurable: true, value: 240 },
        scrollWidth: { configurable: true, value: 1_000 },
      });
      strip.scrollLeft = scrollLeft;
      fireEvent.touchStart(strip, { touches: [{ clientX: startX }] });
      fireEvent.touchEnd(strip, { changedTouches: [{ clientX: endX }] });

      expect(strip.scrollLeft).toBe(scrollLeft);
      expect(
        within(strip)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(keys);
    },
  );

  it.each([true, false])(
    'leaves bottom safe-area spacing to the phone shell (toolbar visible: %s)',
    (toolbarVisible) => {
      saveSettings({ toolbarVisible, language: 'en' });
      render(
        <TerminalProvider>
          <KeyToolbar compact />
        </TerminalProvider>,
      );

      const bar = screen.getByTestId(toolbarVisible ? 'key-toolbar' : 'key-toolbar-collapsed');
      expect(bar.className).not.toContain('safe-area-inset-bottom');
    },
  );

  // Agent shortcuts and base keys share a height so the bar reads as one row.
  it.each([
    { compact: false, height: 'h-7' },
    { compact: true, height: 'h-8' },
  ])('gives every cap one height (compact: $compact)', ({ compact, height }) => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    render(
      <TerminalProvider>
        <KeyToolbar compact={compact} onCustomize={() => {}} />
      </TerminalProvider>,
    );
    expect(screen.getByTestId('agent-key-customize')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /function keys/i }));
    expect(screen.getByRole('button', { name: 'F7' })).toBeInTheDocument();
    const buttons = within(screen.getByTestId('key-toolbar-row')).getAllByRole('button');
    for (const button of buttons) {
      const tokens = button.className.split(/\s+/);
      const label = button.getAttribute('aria-label') ?? button.textContent;
      expect({ label, heights: tokens.filter((token) => /^h-\d+$/.test(token)) }).toEqual({
        label,
        heights: [height],
      });
    }
  });

  it('draws arrows, Enter and Shift as Nerd Font icons, not text symbols', () => {
    renderToolbar();

    const bar = screen.getByTestId('key-toolbar');
    for (const name of ['Left (←)', 'Up (↑)', 'Down (↓)', 'Right (→)', 'Enter']) {
      const key = within(bar).getByRole('button', { name });
      expect(key.textContent).not.toMatch(/[←↑↓→⏎]/);
      expect(key.textContent).toMatch(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/u);
    }
    expect(bar.textContent).not.toMatch(/[←↑↓→⏎⇧▾▴]/);
  });

  // Nerd Font glyphs are drawn at very different sizes (a menu caret is a third
  // the height of an arrow); "每个按钮内部图标大小一致" asks for one size.
  it('draws every icon in the same box, scaled from its own outline', () => {
    renderToolbar();

    const icons = Array.from(
      screen.getByTestId('key-toolbar').querySelectorAll<HTMLElement>('[data-key-icon]'),
    );
    expect(icons.length).toBeGreaterThan(5);
    for (const icon of icons) expect(icon.className).toContain('size-[1em]');
    const fontSize = (name: string) => {
      const icon = icons.find((candidate) => candidate.dataset.keyIcon === name);
      return Number.parseFloat((icon!.firstElementChild as HTMLElement).style.fontSize);
    };
    // The small caret is enlarged until its long side matches the arrow's.
    expect(fontSize('open') * 418).toBeCloseTo(fontSize('left') * 660, 5);
  });

  it('pins Enter outside the sideways strip so it can never scroll away', () => {
    renderToolbar();

    const strip = screen.getByTestId('key-toolbar-scroll');
    expect(strip.className).toContain('overflow-x-auto');
    expect(within(strip).queryByRole('button', { name: /enter/i })).toBeNull();
    // The pinned cluster stays outside: paste, image and Enter never scroll.
    expect(within(strip).queryByTestId('image-upload-btn')).toBeNull();
    expect(within(strip).queryByTestId('paste-btn')).toBeNull();

    const enter = within(screen.getByTestId('key-toolbar-row')).getByRole('button', {
      name: /enter/i,
    });
    expect(enter.className).toContain('shrink-0');
  });

  it('collapses to a handle that is named in the interface language', () => {
    saveSettings({ toolbarVisible: false, language: 'zh' });
    render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>,
    );

    const handle = screen.getByTestId('key-toolbar-collapsed');
    expect(handle.textContent).toContain('按键条');
    expect(handle.textContent).not.toContain('keys');
  });
});

describe('Header commands', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // The language switch lives in the session sheet now; the desktop row is
  // one word in Settings either way.
  const renderSheet = () =>
    render(
      <TerminalProvider>
        <MobileControlSheet
          onClose={() => {}}
          onOpenSettings={() => {}}
          onOpenPaste={() => {}}
          onOpenFiles={() => {}}
        />
      </TerminalProvider>,
    );

  it('offers both languages by name and switches with one tap', () => {
    saveSettings({ language: 'zh' });
    renderSheet();

    // The sheet's language row flips to the other locale, no submenu.
    const row = screen.getByRole('button', { name: '界面语言' });
    expect(row).toHaveTextContent('中');
    fireEvent.click(row);
    expect(loadSettings().language).toBe('en');
    expect(screen.getByRole('button', { name: 'Interface language' })).toHaveTextContent('EN');
    expect(screen.getByRole('button', { name: /terminal settings/i })).toBeInTheDocument();
  });

  it('has no command helper or pairing button', () => {
    saveSettings({ language: 'zh' });
    renderSheet();

    expect(screen.getAllByRole('button').map((button) => button.textContent)).not.toEqual(
      expect.arrayContaining(['命令', '配对']),
    );
    expect(screen.getByRole('button', { name: '终端设置' })).toBeInTheDocument();
  });
});
