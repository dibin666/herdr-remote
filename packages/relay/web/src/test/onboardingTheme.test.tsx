import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { OnboardingView } from '../components/OnboardingView';
import { Header } from '../components/Header';
import { getDefaultSettings, loadSettings } from '../utils/storage';

describe('Onboarding UX and Herdr Dark Theme System', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('ships no terminal color defaults, because the host owns them', () => {
    const defaults = getDefaultSettings();
    expect('theme' in defaults).toBe(false);
    expect('colorMode' in defaults).toBe(false);
  });

  // The first-run panel is the only thing on the screen and the only thing the
  // visitor can do; it used to sit in the top-left corner of an otherwise empty
  // terminal, which read as a page that had failed to finish loading.
  it('centres the first-pairing panel in the window', () => {
    const { container } = render(
      <TerminalProvider>
        <OnboardingView />
      </TerminalProvider>
    );

    const layer = container.firstElementChild as HTMLElement;
    expect(layer.className).toContain('justify-center');
    // Centred by auto margins rather than by `items-center`, so a window too
    // short for the panel scrolls instead of clipping its top off.
    const panel = layer.firstElementChild as HTMLElement;
    expect(panel.className).toContain('my-auto');
    expect(layer.className).toContain('overflow-y-auto');
  });

  it('renders OnboardingView on first run when no token exists', () => {
    render(
      <TerminalProvider>
        <OnboardingView />
      </TerminalProvider>
    );

    // Verifies the onboarding title and explanation
    expect(screen.getByText(/Pair with Herdr Remote/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Control Herdr sessions/i)
    ).toBeInTheDocument();

    // Verifies copyable host pairing command
    expect(screen.getByText(/node bin\/service\.js pair/i)).toBeInTheDocument();

    // Verifies pairing code input and connect CTA
    expect(screen.getByPlaceholderText(/e\.g\. 7X9K2A/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Connect & Pair/i })
    ).toBeInTheDocument();
  });

  it('copies pairing command to clipboard with visual feedback', async () => {
    let copiedText = '';
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockImplementation((text: string) => {
          copiedText = text;
          return Promise.resolve();
        }),
      },
    });

    render(
      <TerminalProvider>
        <OnboardingView />
      </TerminalProvider>
    );

    const copyBtn = screen.getByRole('button', { name: /^Copy$/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('node bin/service.js pair');
    expect(copiedText).toBe('node bin/service.js pair');
  });

  it('does not expose an interface theme toggle', () => {
    render(
      <TerminalProvider>
        <Header
          currentView="terminal"
          onNavigate={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
          onToggleVirtualKeyboard={() => {}}
          isVirtualKeyboardOpen={false}
        />
      </TerminalProvider>
    );

    expect(screen.queryByLabelText(/Toggle theme/i)).not.toBeInTheDocument();
    expect('colorMode' in loadSettings()).toBe(false);
  });
});
