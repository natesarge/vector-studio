import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceImage } from "../lib/loadImage";

/** Where the image sits on screen: screenPoint = imagePoint * scale + (x, y). */
interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

interface Props {
  image: SourceImage;
  checkerboard: boolean;
}

/** The big central canvas: shows the image with mouse-wheel zoom and drag-to-pan. */
export default function CanvasView({ image, checkerboard }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  /** Scale and centre the image so it fills the viewport with a small margin. */
  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 32;
    const bar = 40; // keep the zoom bar at the bottom from covering the picture
    const usable = height - bar;
    const scale = clampScale(
      Math.min((width - margin * 2) / image.width, (usable - margin * 2) / image.height),
    );
    setView({
      scale,
      x: (width - image.width * scale) / 2,
      y: (usable - image.height * scale) / 2,
    });
  }, [image]);

  /** Zoom by `factor`, keeping the image point under (cx, cy) fixed on screen. */
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const setScale = useCallback(
    (scale: number) => zoomAt(scale / view.scale),
    [view.scale, zoomAt],
  );

  // Draw the picture and fit it whenever a new image is opened.
  useLayoutEffect(() => {
    const c = canvasRef.current!;
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")!.drawImage(image.bitmap, 0, 0);
    fit();
  }, [image, fit]);

  // Mouse wheel = zoom at the cursor. Registered by hand because React's wheel
  // listener is "passive" and cannot stop the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; make it stronger.
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Drag to pan.
  const last = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!last.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => {
    last.current = null;
    setDragging(false);
  };

  return (
    <div className="canvas-area">
      <div
        ref={viewportRef}
        className={"viewport" + (dragging ? " dragging" : "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        <div
          className={"artboard" + (checkerboard ? " checker" : "")}
          style={{
            width: image.width,
            height: image.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            // Keep pixels crisp when zoomed far in, smooth when zoomed out.
            imageRendering: view.scale > 3 ? "pixelated" : "auto",
          }}
        >
          <canvas ref={canvasRef} />
        </div>
      </div>

      <div className="zoom-bar" role="toolbar" aria-label="Zoom">
        <button onClick={() => zoomAt(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <span className="zoom-value" data-testid="zoom-value">
          {Math.round(view.scale * 100)}%
        </span>
        <button onClick={() => zoomAt(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={fit} title="Fit the image to the window (or double-click)">
          Fit
        </button>
        <button onClick={() => setScale(1)} title="Actual size">
          100%
        </button>
      </div>
    </div>
  );
}
