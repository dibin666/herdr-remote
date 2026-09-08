import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getEffectiveTerminalFontSize,
  clampFontSize,
  isCoarsePointerDevice,
  DEFAULT_DESKTOP_FONT_SIZE,
  DEFAULT_MOBILE_FONT_SIZE,
} from '../utils/terminalLayout';
import {
  readViewportMetrics,
  observeViewportMetrics,
  APP_HEIGHT_VAR,
  KEYBOARD_INSET_VAR,
  KEYBOARD_INSET_THRESHOLD_PX,
} from '../utils/viewportMetrics';

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
const originalMatchMedia = window.matchMedia;

function setInnerSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

function setVisualViewport(value: { height: number; offsetTop?: number } | null): void {
  Object.defineProperty(window, 'visualViewport', {
    value: value
      ? { height: value.height, width: window.innerWidth, offsetTop: value.offsetTop ?? 0, addEventListener() {}, removeEventListener() {} }
      : undefined,
    writable: true,
    configurable: true,
  });
}

describe('Mobile Terminal Typography Base Settings and CSP Compliance', () => {
  afterEach(() => {
    setInnerSize(originalWidth, originalHeight);
    setVisualViewport(null);
    window.matchMedia = originalMatchMedia;
  });

  it('verifies index.html has removed Google Fonts stylesheets and preconnects to comply with strict CSP', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Strict CSP test: No external google fonts references allowed
    expect(htmlContent).not.toContain('fonts.googleapis.com');
    expect(htmlContent).not.toContain('fonts.gstatic.com');
    expect(htmlContent).not.toContain('https://fonts.');
    // Keep pinch zoom available for accessibility; the keyboard resize policy
    // does not require disabling browser zoom.
    expect(htmlContent).not.toContain('maximum-scale=1.0');
    expect(htmlContent).not.toContain('user-scalable=no');
  });

  it('provides built-in Symbols Nerd Font Mono locally without external dependencies', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const cssPath = path.resolve(__dirname, '../index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Font preload is local only
    expect(htmlContent).toContain('/fonts/SymbolsNerdFontMono-Regular.woff2');
    // CSS defines @font-face with Symbols Nerd Font Mono and unicode-range
    expect(cssContent).toContain("font-family: 'Symbols Nerd Font Mono'");
    expect(cssContent).toContain("url('/fonts/SymbolsNerdFontMono-Regular.woff2')");
    expect(cssContent).toContain('unicode-range:');
  });

  it('initializes the dark-only shell from the markup, not from a script', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // The shell has to be established by the document itself. An inline script
    // would be blocked by `script-src 'self'` and silently do nothing, which is
    // exactly how this regressed before: the test asserted the script was
    // present, never that it was allowed to run.
    expect(htmlContent).toMatch(/<html[^>]*class="dark"/);
    expect(htmlContent).toMatch(/<html[^>]*color-scheme:\s*dark/);
    expect(htmlContent).toMatch(/<html[^>]*background-color:\s*#11111b/);
    expect(htmlContent).not.toContain('herdr_remote_session_view_v1');
    expect(htmlContent).not.toContain('prefers-color-scheme');
  });

  it('serves no inline script, so nothing depends on a CSP exemption', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // `script-src 'self'` admits external sources only. Every script tag must
    // therefore carry a `src`; an inline one is dead code that ships a console
    // error to every visitor.
    const scriptTags = htmlContent.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toMatch(/\ssrc=/);
    }
  });

  it('sizes the app shell from the visual viewport, with dvh and % underneath', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    const rootBlock = css.slice(css.indexOf('#root {'));

    // The ladder matters: `100dvh` does not shrink for the iOS soft keyboard,
    // so the variable has to win, but older engines must still get a height.
    expect(rootBlock).toContain('height: var(--app-height, 100dvh)');
    expect(rootBlock).toContain('height: 100dvh');
    expect(css.indexOf('height: 100dvh')).toBeLessThan(css.indexOf('height: var(--app-height'));
  });

  describe('readViewportMetrics', () => {
    it('reports the keyboard inset when the visual viewport shrinks under the layout one', () => {
      setInnerSize(390, 780);
      setVisualViewport({ height: 420 });

      // 780 - 420 = a 360px keyboard: the toolbar has to move above it.
      expect(readViewportMetrics()).toEqual({ height: 420, keyboardInset: 360 });
    });

    it('ignores browser-chrome sized changes so a scroll is not mistaken for a keyboard', () => {
      setInnerSize(390, 780);
      setVisualViewport({ height: 780 - (KEYBOARD_INSET_THRESHOLD_PX - 10) });

      expect(readViewportMetrics().keyboardInset).toBe(0);
    });

    it('falls back to the layout viewport where visualViewport is unavailable', () => {
      setInnerSize(1024, 768);
      setVisualViewport(null);

      expect(readViewportMetrics()).toEqual({ height: 768, keyboardInset: 0 });
    });
  });

  it('mirrors the viewport onto CSS variables and cleans them up on dispose', () => {
    setInnerSize(390, 780);
    setVisualViewport({ height: 420 });

    const target = document.createElement('div');
    const dispose = observeViewportMetrics(target);

    expect(target.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('420px');
    expect(target.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('360px');

    dispose();
    expect(target.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('');
  });

  it('detects a finger-driven device from the media query, not the width alone', () => {
    window.matchMedia = ((query: string) => ({
      matches: /pointer:\s*coarse/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;

    // A wide tablet is still touch-driven...
    setInnerSize(1024, 1366);
    expect(isCoarsePointerDevice()).toBe(true);

    // ...and a narrow desktop window is not.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    setInnerSize(1024, 768);
    expect(isCoarsePointerDevice()).toBe(false);
  });

  describe('getEffectiveTerminalFontSize', () => {
    it('uses stable base font size (13px) for mobile viewports without ballooning', () => {
      // Standard mobile width
      expect(getEffectiveTerminalFontSize(13, 375)).toBe(13);
      expect(getEffectiveTerminalFontSize(15, 360)).toBe(15);

      // Oversized historic settings are safely clamped on mobile
      expect(getEffectiveTerminalFontSize(30, 375)).toBe(15);
      expect(getEffectiveTerminalFontSize(0, 393)).toBe(DEFAULT_MOBILE_FONT_SIZE);
      expect(getEffectiveTerminalFontSize(5, 393)).toBe(12);
    });

    it('honors user custom font size on tablet and desktop screens (>= 640px)', () => {
      expect(getEffectiveTerminalFontSize(16, 1024)).toBe(16);
      expect(getEffectiveTerminalFontSize(18, 1280)).toBe(18);
      expect(getEffectiveTerminalFontSize(20, 1920)).toBe(20);
      expect(getEffectiveTerminalFontSize(14, 768)).toBe(14);
    });
  });

  describe('clampFontSize', () => {
    it('clamps invalid or out-of-range font sizes to safe desktop bounds [10, 24]', () => {
      expect(clampFontSize(0)).toBe(DEFAULT_DESKTOP_FONT_SIZE);
      expect(clampFontSize(-5)).toBe(DEFAULT_DESKTOP_FONT_SIZE);
      expect(clampFontSize('invalid' as unknown as number)).toBe(DEFAULT_DESKTOP_FONT_SIZE);
      expect(clampFontSize(5)).toBe(10); // clamped to min 10
      expect(clampFontSize(35)).toBe(24); // clamped to max 24
      expect(clampFontSize(16)).toBe(16);
    });
  });
});
