import { useMemo, useRef, useState } from "react";
import type { Editor } from "./useEditor";
import {
  bounds, buildPath, insertNode, parseNodes, rotateAbout, scaleAbout, translate,
  type Matrix, type SubPath,
} from "./geom";

interface Props {
  ed: Editor;
  /** Drawing units per screen pixel, so handles stay the same size at any zoom. */
  unit: number;
  outlines: boolean;
  showShapes: boolean;
  style?: React.CSSProperties;
}

type Drag =
  | { kind: "move"; sx: number; sy: number; id: number; moved: boolean; shift: boolean }
  | { kind: "scale"; hx: number; hy: number; free: boolean }
  | { kind: "rotate"; start: number }
  | { kind: "node"; sub: number; idx: number; part: "point" | "in" | "out"; sx: number; sy: number; base: SubPath[] };

/**
 * The editable drawing, shown as SVG on top of the artboard. Handles shape
 * selection, dragging, the scale/rotate box and node editing.
 *
 * Mouse rules: click a shape to select it (Shift adds). Drag a selected shape
 * to move it. Dragging anything else pans the view (handled by the pane).
 */
export default function EditorLayer({ ed, unit, outlines, showShapes, style }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Temporary matrix shown while dragging; baked into the paths on release. */
  const [live, setLive] = useState<Matrix | null>(null);
  const [activeNode, setActiveNode] = useState<{ sub: number; idx: number } | null>(null);
  const { width: W, height: H } = ed.size;
  const box = ed.selectionBox;

  /** Mouse position in drawing units. */
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const capture = (e: React.PointerEvent) => {
    e.stopPropagation(); // do not let the pane start panning
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  // Node editing applies to exactly one selected shape.
  const nodeShape = ed.nodeEdit && ed.selected.length === 1 ? ed.selected[0] : null;
  const subs = useMemo(() => (nodeShape ? parseNodes(nodeShape.d) : null), [nodeShape]);

  // ------------------------------------------------------------ pointer handlers
  const onShapeDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0 || nodeShape || !ed.selection.has(id)) return; // unselected: let the pane handle it
    capture(e);
    const p = pos(e);
    drag.current = { kind: "move", sx: p.x, sy: p.y, id, moved: false, shift: e.shiftKey };
  };
  const onHandleDown = (e: React.PointerEvent, hx: number, hy: number) => {
    capture(e);
    drag.current = { kind: "scale", hx, hy, free: e.shiftKey };
  };
  const onRotateDown = (e: React.PointerEvent) => {
    if (!box) return;
    capture(e);
    const p = pos(e);
    drag.current = { kind: "rotate", start: Math.atan2(p.y - (box.y + box.h / 2), p.x - (box.x + box.w / 2)) };
  };
  const onNodeDown = (e: React.PointerEvent, sub: number, idx: number, part: "point" | "in" | "out") => {
    if (!subs) return;
    capture(e);
    const p = pos(e);
    setActiveNode({ sub, idx });
    drag.current = { kind: "node", sub, idx, part, sx: p.x, sy: p.y, base: subs };
  };

  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const p = pos(e);
    if (g.kind === "move") {
      const dx = p.x - g.sx, dy = p.y - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 3 * unit) return; // ignore tiny wobbles when clicking
      g.moved = true;
      setLive(translate(dx, dy));
    } else if (g.kind === "scale" && box) {
      // The corner/side opposite the dragged handle stays put.
      const ax = box.x + (g.hx < 0 ? box.w : g.hx > 0 ? 0 : box.w / 2);
      const ay = box.y + (g.hy < 0 ? box.h : g.hy > 0 ? 0 : box.h / 2);
      let sx = g.hx ? (p.x - ax) / (g.hx * box.w || 1) : 1;
      let sy = g.hy ? (p.y - ay) / (g.hy * box.h || 1) : 1;
      // Corners keep proportions unless Shift is held.
      if (g.hx && g.hy && !(g.free || e.shiftKey)) sx = sy = Math.abs(sx) > Math.abs(sy) ? sx : sy;
      const tiny = 0.01;
      if (Math.abs(sx) < tiny) sx = tiny;
      if (Math.abs(sy) < tiny) sy = tiny;
      setLive(scaleAbout(sx, sy, ax, ay));
    } else if (g.kind === "rotate" && box) {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      let deg = ((Math.atan2(p.y - cy, p.x - cx) - g.start) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift snaps to 15 degree steps
      setLive(rotateAbout(deg, cx, cy));
    } else if (g.kind === "node" && nodeShape) {
      const dx = p.x - g.sx, dy = p.y - g.sy;
      const next = g.base.map((sp, si) => si !== g.sub ? sp : {
        ...sp,
        nodes: sp.nodes.map((n, ni) => {
          if (ni !== g.idx) return n;
          if (g.part === "point") return { ...n, x: n.x + dx, y: n.y + dy };
          if (g.part === "in") return { ...n, ix: n.ix + dx, iy: n.iy + dy };
          return { ...n, ox: n.ox + dx, oy: n.oy + dy };
        }),
      });
      const d = buildPath(next);
      ed.preview(ed.shapes.map((s) => (s.id === nodeShape.id ? { ...s, d } : s)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    if (g.kind === "node") return ed.commitPreview();
    if (g.kind === "move" && !g.moved) {
      // A click (no drag) on an already selected shape.
      if (g.shift || e.shiftKey) ed.select([g.id], true);
      else if (ed.selection.size > 1) ed.select([g.id]);
    } else if (live) {
      ed.transform(live);
    }
    setLive(null);
  };

  /** Double-click the outline in node mode to add a point there. */
  const onOutlineDouble = (e: React.MouseEvent) => {
    if (!nodeShape) return;
    e.stopPropagation();
    const p = pos(e);
    const d = insertNode(nodeShape.d, p.x, p.y);
    ed.set(ed.shapes.map((s) => (s.id === nodeShape.id ? { ...s, d } : s)));
  };
  /** Double-click a point to remove it. */
  const removeNode = (e: React.MouseEvent, sub: number, idx: number) => {
    e.stopPropagation();
    if (!subs || !nodeShape || subs[sub].nodes.length <= 3) return;
    const next = subs.map((sp, si) => (si === sub ? { ...sp, nodes: sp.nodes.filter((_, i) => i !== idx) } : sp));
    setActiveNode(null);
    ed.set(ed.shapes.map((s) => (s.id === nodeShape.id ? { ...s, d: buildPath(next) } : s)));
  };

  // ------------------------------------------------------------ drawing
  const liveAttr = live ? `matrix(${live.join(" ")})` : undefined;
  const hs = 9 * unit; // handle size
  const handles: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const cursors: Record<string, string> = {
    "-1,-1": "nwse-resize", "1,1": "nwse-resize", "1,-1": "nesw-resize", "-1,1": "nesw-resize",
    "0,-1": "ns-resize", "0,1": "ns-resize", "-1,0": "ew-resize", "1,0": "ew-resize",
  };
  const an = subs && activeNode && subs[activeNode.sub]?.nodes[activeNode.idx];

  return (
    <svg
      ref={svgRef}
      className={"layer editor-layer" + (outlines ? " outlines" : "") + (showShapes ? " show-shapes" : "")}
      style={style}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {ed.shapes.map((s) => (
        <path
          key={s.id}
          data-shape-id={s.id}
          d={s.d}
          fill={s.fill}
          transform={ed.selection.has(s.id) ? liveAttr : undefined}
          onPointerDown={(e) => onShapeDown(e, s.id)}
        />
      ))}

      {/* Selection: an outline around each selected shape. */}
      {ed.selected.map((s) => (
        <path
          key={"sel" + s.id}
          className={"sel-outline" + (nodeShape ? " hit" : "")}
          d={s.d}
          transform={liveAttr}
          onDoubleClick={onOutlineDouble}
        />
      ))}

      {/* Scale / rotate box (hidden while editing nodes). */}
      {box && !nodeShape && (
        <g transform={liveAttr} className="sel-box" data-testid="selection-box">
          <rect x={box.x} y={box.y} width={box.w} height={box.h} />
          <line x1={box.x + box.w / 2} y1={box.y} x2={box.x + box.w / 2} y2={box.y - 26 * unit} />
          <circle
            className="handle rotate"
            cx={box.x + box.w / 2}
            cy={box.y - 26 * unit}
            r={hs * 0.6}
            onPointerDown={onRotateDown}
          >
            <title>Drag to rotate (hold Shift for 15° steps)</title>
          </circle>
          {handles.map(([hx, hy]) => (
            <rect
              key={hx + "," + hy}
              className="handle"
              data-handle={hx + "," + hy}
              x={box.x + ((hx + 1) / 2) * box.w - hs / 2}
              y={box.y + ((hy + 1) / 2) * box.h - hs / 2}
              width={hs}
              height={hs}
              style={{ cursor: cursors[hx + "," + hy] }}
              onPointerDown={(e) => onHandleDown(e, hx, hy)}
            />
          ))}
        </g>
      )}

      {/* Node editing: every point, plus the curve handles of the active point. */}
      {subs && (
        <g className="nodes" data-testid="nodes">
          {an && activeNode && (
            <>
              <line x1={an.x} y1={an.y} x2={an.x + an.ix} y2={an.y + an.iy} />
              <line x1={an.x} y1={an.y} x2={an.x + an.ox} y2={an.y + an.oy} />
              <circle className="handle curve" cx={an.x + an.ix} cy={an.y + an.iy} r={hs * 0.45}
                onPointerDown={(e) => onNodeDown(e, activeNode.sub, activeNode.idx, "in")} />
              <circle className="handle curve" cx={an.x + an.ox} cy={an.y + an.oy} r={hs * 0.45}
                onPointerDown={(e) => onNodeDown(e, activeNode.sub, activeNode.idx, "out")} />
            </>
          )}
          {subs.map((sp, si) =>
            sp.nodes.map((n, ni) => (
              <rect
                key={si + "-" + ni}
                className={"handle node" + (activeNode?.sub === si && activeNode.idx === ni ? " active" : "")}
                x={n.x - hs * 0.4}
                y={n.y - hs * 0.4}
                width={hs * 0.8}
                height={hs * 0.8}
                onPointerDown={(e) => onNodeDown(e, si, ni, "point")}
                onDoubleClick={(e) => removeNode(e, si, ni)}
              />
            )),
          )}
        </g>
      )}
    </svg>
  );
}

/** Size of a shape in drawing units, for the layers list. */
export const shapeSize = (d: string) => {
  const b = bounds(d);
  return `${Math.round(b.w)} × ${Math.round(b.h)}`;
};
