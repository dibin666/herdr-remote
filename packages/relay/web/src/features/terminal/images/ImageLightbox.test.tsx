import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalProvider } from '@/context/TerminalContext';
import { ImageLightbox } from './ImageLightbox';

const image = { width: 200, height: 100, close: vi.fn() } as unknown as ImageBitmap;

// jsdom has no 2D canvas; the draw is a no-op, gestures still exercise the code.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
  drawImage: vi.fn(),
} as unknown as CanvasRenderingContext2D);

function renderLightbox(onClose = vi.fn()) {
  const utils = render(
    <TerminalProvider>
      <ImageLightbox image={image} onClose={onClose} />
    </TerminalProvider>,
  );
  const overlay = screen.getByRole('dialog');
  const canvas = overlay.querySelector('canvas') as HTMLCanvasElement;
  return { overlay, canvas, onClose, ...utils };
}

/** jsdom elements have no layout; the overlay reports an 800x600 viewport. */
function stubViewport() {
  const rect = {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
}

const scaleOf = (canvas: HTMLCanvasElement) =>
  Number(/scale\(([^)]+)\)/.exec(canvas.style.transform)?.[1]);

describe('ImageLightbox', () => {
  let rectSpy: ReturnType<typeof stubViewport> | null = null;

  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = null;
  });

  it('fits the image inside the viewport on open', () => {
    rectSpy = stubViewport();
    const { canvas } = renderLightbox();
    // 200x100 in 800x600: limited by width -> scale 4, centered vertically.
    expect(scaleOf(canvas)).toBeCloseTo(4);
    expect(canvas.style.transform).toContain('translate(0px, 100px)');
  });

  it('closes on a tap on the dimmed area', () => {
    rectSpy = stubViewport();
    const { overlay, onClose } = renderLightbox();
    // The image covers y 100..500; y=20 is backdrop.
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 400, clientY: 20 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 400, clientY: 20 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a tap on the image itself', () => {
    rectSpy = stubViewport();
    const { overlay, onClose } = renderLightbox();
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 400, clientY: 300 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on the corner button and on Escape', () => {
    rectSpy = stubViewport();
    const { onClose, unmount } = renderLightbox();
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const second = renderLightbox();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('zooms in on a mouse wheel', () => {
    rectSpy = stubViewport();
    const { overlay, canvas } = renderLightbox();
    const before = scaleOf(canvas);
    fireEvent.wheel(overlay, { deltaY: -100, clientX: 400, clientY: 300 });
    expect(scaleOf(canvas)).toBeGreaterThan(before);
  });

  it('stays put on a drag that starts on the backdrop', () => {
    rectSpy = stubViewport();
    const { overlay, canvas, onClose } = renderLightbox();
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 400, clientY: 20 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 480, clientY: 80 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 480, clientY: 80 });
    expect(onClose).not.toHaveBeenCalled();
    // The drag panned the image rather than dismissing it.
    expect(canvas.style.transform).not.toContain('translate(0px, 100px)');
  });

  it('pinch zooms with two fingers', () => {
    rectSpy = stubViewport();
    const { overlay, canvas } = renderLightbox();
    const before = scaleOf(canvas);
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 350, clientY: 300 });
    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 450, clientY: 300 });
    fireEvent.pointerMove(overlay, { pointerId: 2, clientX: 550, clientY: 300 });
    fireEvent.pointerUp(overlay, { pointerId: 2, clientX: 550, clientY: 300 });
    expect(scaleOf(canvas)).toBeGreaterThan(before);
  });
});
