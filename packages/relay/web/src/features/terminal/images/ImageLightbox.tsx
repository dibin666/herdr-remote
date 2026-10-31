// The image a pane drew, shown big enough to actually read: full-screen
// overlay, wheel zoom on a mouse, pinch zoom and drag on a touch screen.
// A tap on the dimmed area, the ✕ or Escape closes it.

import type React from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '@/context/TerminalContext';
import {
  clampScale,
  clampToViewport,
  fitTransform,
  panBy,
  zoomAtPoint,
  zoomBounds,
  type ZoomTransform,
} from './imageZoom';

/** A press-and-release shorter than this and moving less is a tap, not a drag. */
const TAP_SLOP_PX = 8;
/** Per unit of wheel deltaY; one notch is ~100px, so ~0.8x per notch. */
const WHEEL_ZOOM_PER_PX = 0.0022;

type Gesture = 'idle' | 'tap' | 'pan' | 'pinch';

interface TrackedPoint {
  x: number;
  y: number;
}

export interface ImageLightboxProps {
  image: ImageBitmap;
  onClose: () => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({ image, onClose }) => {
  const { t } = useSettings();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The transform lives outside React state: gesture frames mutate it and the
  // style directly, so a pinch at 120 Hz does not render 120 times.
  const transformRef = useRef<ZoomTransform>({ scale: 1, tx: 0, ty: 0 });
  const fitScaleRef = useRef(1);
  /** Once the user has zoomed, a viewport resize leaves their framing alone. */
  const touchedRef = useRef(false);
  const gestureRef = useRef<Gesture>('idle');
  const pointersRef = useRef(new Map<number, TrackedPoint>());
  const downRef = useRef<TrackedPoint>({ x: 0, y: 0 });
  /** Whether the tap began on the backdrop rather than on the image. */
  const downOnBackdropRef = useRef(false);
  const pinchRef = useRef({ dist: 0, mid: { x: 0, y: 0 } });

  const applyTransform = () => {
    const el = canvasRef.current;
    if (!el) return;
    const { scale, tx, ty } = transformRef.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const viewSize = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { w: rect?.width ?? 0, h: rect?.height ?? 0 };
  };

  const setTransform = (next: ZoomTransform, markTouched = true) => {
    const { w, h } = viewSize();
    transformRef.current = clampToViewport(next, w, h, image.width, image.height);
    if (markTouched) touchedRef.current = true;
    applyTransform();
  };

  const zoomTowards = (x: number, y: number, scale: number) => {
    const bounded = clampScale(scale, zoomBounds(fitScaleRef.current));
    setTransform(zoomAtPoint(transformRef.current, x, y, bounded));
  };

  // The bitmap is drawn once; zooming is a CSS transform on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.drawImage(image, 0, 0);
  }, [image]);

  // Fit on mount and whenever the viewport changes, until the user frames it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the helpers read refs; `image` covers reopening
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const refit = () => {
      if (touchedRef.current) return;
      const rect = root.getBoundingClientRect();
      const fit = fitTransform(rect.width, rect.height, image.width, image.height);
      fitScaleRef.current = fit.scale;
      transformRef.current = fit;
      applyTransform();
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [image]);

  // React registers wheel listeners as passive; zooming needs preventDefault.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `image` covers reopening; the rest read refs or stable props
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTowards(
        e.clientX,
        e.clientY,
        transformRef.current.scale * Math.exp(-e.deltaY * WHEEL_ZOOM_PER_PX),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey, true);
    return () => {
      root.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [image]);

  const pointIsOnImage = (x: number, y: number): boolean => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const { scale, tx, ty } = transformRef.current;
    const lx = x - rect.left;
    const ly = y - rect.top;
    return (
      lx >= tx && lx <= tx + image.width * scale && ly >= ty && ly <= ty + image.height * scale
    );
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const root = rootRef.current;
    if (!root) return;
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // jsdom and older engines lack capture; gestures still work without it.
    }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 1) {
      gestureRef.current = 'tap';
      downRef.current = { x: e.clientX, y: e.clientY };
      downOnBackdropRef.current = !pointIsOnImage(e.clientX, e.clientY);
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      gestureRef.current = 'pinch';
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(e.pointerId);
    if (!prev) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const current = { x: e.clientX, y: e.clientY };

    if (gestureRef.current === 'tap') {
      if (Math.hypot(current.x - downRef.current.x, current.y - downRef.current.y) > TAP_SLOP_PX) {
        gestureRef.current = 'pan';
      }
    }
    if (gestureRef.current === 'pan') {
      setTransform(panBy(transformRef.current, current.x - prev.x, current.y - prev.y));
      return;
    }
    if (gestureRef.current === 'pinch' && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const pinch = pinchRef.current;
      if (pinch.dist > 0 && dist > 0) {
        // Zoom at the fingers' midpoint, then follow its drift — a pinch is a
        // zoom and a pan in one motion.
        zoomTowards(mid.x, mid.y, transformRef.current.scale * (dist / pinch.dist));
        setTransform(panBy(transformRef.current, mid.x - pinch.mid.x, mid.y - pinch.mid.y));
      }
      pinchRef.current = { dist, mid };
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const wasTap = gestureRef.current === 'tap';
    pointersRef.current.delete(e.pointerId);
    if (wasTap && !cancelled && downOnBackdropRef.current) {
      onClose();
      return;
    }
    if (pointersRef.current.size === 0) {
      gestureRef.current = 'idle';
      return;
    }
    // A pinch losing a finger becomes a drag on the remaining one, whose last
    // position is already in the map as the new pan baseline.
    if (pointersRef.current.size === 1) gestureRef.current = 'pan';
  };

  const overlay = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('terminal.imagePreviewAria')}
      className="fixed inset-0 z-[60] select-none overflow-hidden bg-black/90"
      style={{ height: 'var(--app-height, 100dvh)', width: '100vw', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', maxWidth: 'none', maxHeight: 'none' }}
      />
      <button
        type="button"
        className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center border border-tui-border bg-tui-base/80 font-mono text-lg leading-none text-tui-text hover:border-tui-accent hover:text-tui-accent"
        aria-label={t('terminal.imageClose')}
        title={t('terminal.imageClose')}
        // Keep the press out of the gesture map; the click alone closes.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
};
