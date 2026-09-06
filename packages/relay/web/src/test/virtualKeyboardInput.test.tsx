import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalProvider } from '../context/TerminalContext';
import { VirtualKeyboardHelper } from '../components/VirtualKeyboardHelper';

describe('Virtual keyboard helper input policy', () => {
  it('keeps the visible field as an explicit IME target', () => {
    render(
      <TerminalProvider>
        <VirtualKeyboardHelper isOpen={true} onClose={vi.fn()} />
      </TerminalProvider>
    );

    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).toHaveAttribute('enterkeyhint', 'send');

    input.focus();
    expect(document.activeElement).toBe(input);
  });
});
