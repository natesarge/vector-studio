import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceImage } from "../lib/loadImage";
import EditorLayer from "../editor/EditorLayer";
import type { Editor } from "../editor/useEditor";
import { rgbToHex } from "../pipeline/color";

export type ViewMode = "original" | "result" | "side" | "slider";

/** Where the image sits on screen: screenPoint = imagePoint * scale + (x, y). */
interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The original picture, drawn once onto a canvas. */
function OriginalLayer({ image, dim }: { image: SourceImage; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current!;
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")!.drawImage(image.bitmap, 0, 0);
  }, [image]);
  return <canvas ref={ref} className={"layer original-layer" + (dim ? " dim" : "")} />;
}

interface PaneProps {
  kind: "original" | "result" | "slider";
  label?: string;
  image: SourceImage;
  ed: Editor;
  showShapes: boolean;
  /** When set, the next click picks a colour instead of selecting. */
  onPickColor: ((hex: string) => void) | null;
  view: View;
  setView: React.Dispatch<React.SetStateAction<View>>;
  zoomAt: (el: HTMLElement, factor: number, cx?: number, cy?: number) => void;
  onFit: () => void;
  checkerboard: boolean;
  outlines: boolean;
  paneRef?: React.Ref<HTMLDivElement>;
}

/** One view of the artwork. Side-by-side mode shows two of these in step. */
function Pane({ kind, label, image, ed, showShapes, onPickColor, view, setView, zoomAt, onFit, checkerboard, outlines, paneRef }: PaneProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(0.5); // slider position, 0..1 across the image

  // Mouse wheel = zoom at the cursor. Registered by hand because React's wheel
  // listener is "passive" and cannot stop the page from scrolling.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; make it stronger.
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(el, Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Drag to pan. A press and release without movement is a "tap" (a click):
  // it selects the shape under the mouse, or picks a colour in pick mode.
  const last = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<{ target: Element; x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    press.current = e.button === 0 ? { target: e.target as Element, x: e.clientX, y: e.clientY, moved: false } : null;
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!last.current) return;
    const pr = press.current;
    if (pr && !pr.moved) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 4) return; // still a click
      pr.moved = true;
    }
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    if (!onPickColor) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const pr = press.current;
    press.current = null;
    if (last.current && pr && !pr.moved) onTap(pr.target, e);
    last.current = null;
    setDragging(false);
  };
  const onTap = (target: Element, e: React.PointerEvent) => {
    const shapeEl = target.closest("[data-shape-id]");
    if (onPickColor) {
      if (shapeEl) return onPickColor(shapeEl.getAttribute("fill")!.toUpperCase());
      if (target instanceof HTMLCanvasElement) {
        // Read the pixel of the original picture under the mouse.
        const r = target.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) / r.width) * target.width);
        const y = Math.floor(((e.clientY - r.top) / r.height) * target.height);
        const px = target.getContext("2d")!.getImageData(x, y, 1, 1).data;
        return onPickColor(rgbToHex(px[0], px[1], px[2]));
      }
      return;
    }
    if (kind === "original") return;
    if (shapeEl) ed.select([Number(shapeEl.getAttribute("data-shape-id"))], e.shiftKey);
    else if (!target.closest(".handle") && !e.shiftKey) ed.clearSelection();
  };

  // Dragging the before/after divider.
  const onSplitMove = (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = ref.current!.getBoundingClientRect();
    const imgX = (e.clientX - r.left - view.x) / view.scale;
    setSplit(Math.min(1, Math.max(0, imgX / image.width)));
  };

  const hasResult = ed.shapes.length > 0;
  const showOriginal = kind !== "result" || !hasResult;
  const showResult = kind !== "original" && hasResult;
  const splitX = view.x + split * image.width * view.scale;

  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (typeof paneRef === "function") paneRef(el);
        else if (paneRef) paneRef.current = el;
      }}
      className={"viewport" + (dragging ? " dragging" : "") + (onPickColor ? " picking" : "")}
      data-pane={kind}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        // Double-click empty space to fit; on a shape it is used for node editing.
        if (!(e.target as Element).closest("[data-shape-id], .sel-outline, .handle")) onFit();
      }}
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
        {showOriginal && <OriginalLayer image={image} dim={kind === "result"} />}
        {showResult && (
          <EditorLayer
            ed={ed}
            unit={ed.size.width / (image.width * view.scale)}
            outlines={outlines}
            showShapes={showShapes}
            style={kind === "slider" ? { clipPath: `inset(0 0 0 ${split * 100}%)` } : undefined}
          />
        )}
      </div>

      {kind === "slider" && hasResult && (
        <div
          className="split-handle"
          style={{ left: splitX }}
          role="slider"
          aria-label="Before / after divider"
          aria-valuenow={Math.round(split * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          title="Drag to compare the original (left) with the result (right)"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onSplitMove}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="split-knob">◂ ▸</span>
        </div>
      )}
      {label && <span className="pane-label">{label}</span>}
    </div>
  );
}

interface Props {
  image: SourceImage;
  ed: Editor;
  mode: ViewMode;
  checkerboard: boolean;
  outlines: boolean;
  showShapes: boolean;
  onPickColor: ((hex: string) => void) | null;
}

/** The big central area: one or two panes plus the zoom buttons. */
export default function CanvasView({ image, ed, mode, checkerboard, outlines, showShapes, onPickColor }: Props) {
  const firstPane = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });

  /** Scale and centre the image so it fills a pane with a small margin. */
  const fit = useCallback(() => {
    const el = firstPane.current;
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
  const zoomAt = useCallback((el: HTMLElement, factor: number, cx?: number, cy?: number) => {
    const r = el.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);
  const zoomButton = (factor: number) => firstPane.current && zoomAt(firstPane.current, factor);

  // Fit when a new image opens or the layout changes (one pane <-> two panes).
  const twoPanes = mode === "side";
  useLayoutEffect(fit, [fit, twoPanes]);

  const common = { image, ed, showShapes, onPickColor, view, setView, zoomAt, onFit: fit, checkerboard, outlines };
  return (
    <div className="canvas-area">
      <div className="panes">
        {mode === "side" ? (
          <>
            <Pane {...common} kind="original" label="Original" paneRef={firstPane} />
            <Pane {...common} kind="result" label="Result" />
          </>
        ) : (
          <Pane {...common} kind={mode} paneRef={firstPane} />
        )}
      </div>

      {onPickColor && <div className="pick-banner">Click the picture to pick a color · Esc to cancel</div>}

      <div className="zoom-bar" role="toolbar" aria-label="Zoom">
        <button onClick={() => zoomButton(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <span className="zoom-value" data-testid="zoom-value">
          {Math.round(view.scale * 100)}%
        </span>
        <button onClick={() => zoomButton(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={fit} title="Fit the image to the window (or double-click)">
          Fit
        </button>
        <button onClick={() => zoomButton(1 / view.scale)} title="Actual size">
          100%
        </button>
      </div>
    </div>
  );
}
