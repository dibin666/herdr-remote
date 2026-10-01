import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KeyToolbar } from './KeyToolbar';
import { Header } from '@/app/Header';
import { TerminalProvider } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
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

  const renderToolbar = () => {
    saveSettings({ toolbarVisible: true, language: 'en' });
    return render(
      <TerminalProvider>
        <KeyToolbar />
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
    // ...and the way out is at the other end, not occupying the thumb's spot.
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringMatching(/collapse/i));
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

  // Agent shortcuts at h-8 beside h-9 keys were reported as "一大一小": every
  // cap on the bar, drawers and shortcuts included, shares one height.
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
    fireEvent.click(screen.getByRole('button', { name: /function keys/i }));

    const buttons = within(screen.getByTestId('key-toolbar')).getAllByRole('button');
    expect(screen.getByTestId('agent-key-customize')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'F7' })).toBeInTheDocument();
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
    // Everything else, the image button included, still scrolls.
    expect(within(strip).getByTestId('image-upload-btn')).toBeInTheDocument();

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

  const renderHeader = () =>
    render(
      <TerminalProvider>
        <Header currentView="terminal" onNavigate={() => {}} onOpenSettings={() => {}} />
      </TerminalProvider>,
    );

  it('offers both languages by name and switches with one tap', () => {
    saveSettings({ language: 'zh' });
    renderHeader();

    const zh = screen.getByRole('radio', { name: '中' });
    const en = screen.getByRole('radio', { name: 'EN' });
    expect(zh).toBeChecked();
    fireEvent.click(en);
    expect(screen.getByRole('radio', { name: 'EN' })).toBeChecked();
    expect(screen.getByRole('button', { name: /terminal settings/i }).textContent).toBe('cfg');
  });

  it('has no command helper or pairing button', () => {
    saveSettings({ language: 'zh' });
    renderHeader();

    expect(screen.getAllByRole('button').map((button) => button.textContent)).not.toEqual(
      expect.arrayContaining(['命令', '配对']),
    );
    expect(screen.getByRole('button', { name: '终端设置' }).textContent).toBe('设置');
  });
});
