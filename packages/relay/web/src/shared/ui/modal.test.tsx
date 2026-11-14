import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './modal';

function Nested({ onOuterClose }: { onOuterClose: () => void }) {
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <Modal isOpen onClose={onOuterClose} title="Outer" closeLabel="Close outer">
      <p>outer body</p>
      <button type="button" onClick={() => setInnerOpen(true)}>
        open inner
      </button>
      <Modal isOpen={innerOpen} onClose={() => setInnerOpen(false)} title="Inner" closeLabel="x">
        <p>inner body</p>
      </Modal>
    </Modal>
  );
}

describe('Modal', () => {
  it('closes on Escape, as the esc cap in its title bar says', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Paste" closeLabel="Close">
        <p>body</p>
      </Modal>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves chords alone', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Paste" closeLabel="Close">
        <p>body</p>
      </Modal>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'Escape', altKey: true });
    fireEvent.keyDown(document.body, { key: 'Escape', metaKey: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives Escape to the dialog on top, one at a time', () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    // The way a second dialog arrives: opened from the one already up.
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    expect(screen.getByText('inner body')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('inner body')).toBeNull();
    expect(onOuterClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOuterClose).toHaveBeenCalledTimes(1);
  });

  it('takes focus from what is behind it and hands it back when it closes', () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          <Modal isOpen={open} onClose={() => setOpen(false)} title="Settings" closeLabel="Close">
            <p>body</p>
          </Modal>
        </>
      );
    };
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    fireEvent.click(opener);

    // Keys typed now belong to the dialog, not to whatever it covers.
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps a field that asked for focus focused', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Rename" closeLabel="Close">
        {/* biome-ignore lint/a11y/noAutofocus: the behaviour under test */}
        <input aria-label="name" autoFocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('name'));
  });

  it('names itself by its title even when two dialogs share one', () => {
    render(
      <>
        <Modal isOpen onClose={() => {}} title="Update" closeLabel="a">
          <p>one</p>
        </Modal>
        <Modal isOpen onClose={() => {}} title="Update" closeLabel="b">
          <p>two</p>
        </Modal>
      </>,
    );
    const [first, second] = screen.getAllByRole('dialog');
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
    expect(first).toHaveAccessibleName('Update');
  });
});
