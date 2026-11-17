import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor, RegionTool } from "./useEditor";
import { useFonts } from "../text/fonts";
import { getLayout, textParts } from "../text/layout";
import type { Pt } from "../text/lettering";
import { nodeKey } from "./pathops";
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
  /** Called with the line or outline the user drew with a box/lasso/knife tool. */
  onRegion: (points: Pt[], tool: RegionTool) => void;
  style?: React.CSSProperties;
}

type Drag =
  | { kind: "move"; sx: number; sy: number; id: number; moved: boolean; shift: boolean }
  | { kind: "text"; sx: number; sy: number; id: number; moved: boolean }
  | { kind: "region"; pts: Pt[] }
  | { kind: "scale"; hx: number; hy: number; free: boolean }
  | { kind: "rotate"; start: number }
  | {
      kind: "node"; sub: number; idx: number; part: "point" | "in" | "out"; sx: number; sy: number;
      base: SubPath[]; keys: ReadonlySet<string>; moved: boolean; wasSelected: boolean; shift: boolean;
    }
  | { kind: "nodebox"; a: Pt; shift: boolean };

/**
 * The editable drawing, shown as SVG on top of the artboard. Handles shape
 * selection, dragging, the scale/rotate box, node editing and the tools that
 * draw on the picture (Replace lettering, Knife).
 *
 * Mouse rules: click a shape to select it (Shift adds, Alt cycles through the
 * shapes underneath). Drag a selected shape to move it. Dragging anything
 * else pans the view (handled by the pane). While editing nodes, dragging on
 * the picture draws a selection box; hold Space to pan instead.
 */
export default function EditorLayer({ ed, unit, outlines, showShapes, onRegion, style }: Props) {
  const fonts = useFonts();
  const [region, setRegion] = useState<Pt[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [nodeBox, setNodeBox] = useState<{ a: Pt; b: Pt } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const spaceDown = useRef(false);
  /** Temporary matrix shown while dragging; baked into the paths on release. */
  const [live, setLive] = useState<Matrix | null>(null);
  const { width: W, height: H } = ed.size;
  const box = ed.selectionBox;
  const tool = ed.regionTool;

  // Node editing applies to exactly one selected shape.
  const nodeShape = ed.nodeEdit && ed.selected.length === 1 ? ed.selected[0] : null;
  const subs = useMemo(() => (nodeShape ? parseNodes(nodeShape.d) : null), [nodeShape]);
  const pointCount = subs ? subs.reduce((n, sp) => n + sp.nodes.length, 0) : 0;

  // Hold Space while editing nodes to pan instead of drawing a selection box.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      spaceDown.current = true;
      if (ed.nodeEdit) e.preventDefault(); // no page scroll or button press
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && (spaceDown.current = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [ed.nodeEdit]);

  // No hover outline while a tool or drag is active.
  useEffect(() => setHover(null), [tool, ed.nodeEdit]);

  /** Mouse position in drawing units. */
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const capture = (e: React.PointerEvent) => {
    e.stopPropagation(); // do not let the pane start panning
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  // ------------------------------------------------------------ pointer handlers
  const onShapeDown = (e: React.PointerEvent, id: number) => {
    // Unselected shapes, and Alt+click (cycle), are handled by the pane as a click.
    if (e.button !== 0 || nodeShape || e.altKey || !ed.selection.has(id)) return;
    capture(e);
    const p = pos(e);
    drag.current = { kind: "move", sx: p.x, sy: p.y, id, moved: false, shift: e.shiftKey };
  };
  const onTextDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0 || ed.selectedText?.id !== id) return; // unselected: a click selects it (pane)
    capture(e);
    const p = pos(e);
    drag.current = { kind: "text", sx: p.x, sy: p.y, id, moved: false };
  };
  const onRegionDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capture(e);
    const p = pos(e);
    drag.current = { kind: "region", pts: [p] };
    setRegion([p]);
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
    if (!subs || e.button !== 0) return;
    capture(e);
    const p = pos(e);
    const key = nodeKey(sub, idx);
    const wasSelected = ed.nodeSel.has(key);
    let keys: ReadonlySet<string> = ed.nodeSel;
    if (part === "point") {
      if (e.shiftKey) {
        const next = new Set(ed.nodeSel);
        if (wasSelected) next.delete(key); else next.add(key);
        keys = next;
      } else if (!wasSelected) keys = new Set([key]);
      if (keys !== ed.nodeSel) ed.setNodeSel(keys);
    }
    drag.current = { kind: "node", sub, idx, part, sx: p.x, sy: p.y, base: subs, keys, moved: false, wasSelected, shift: e.shiftKey };
  };
  const onNodeBoxDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || spaceDown.current) return; // Space held: let the pane pan
    capture(e);
    const a = pos(e);
    drag.current = { kind: "nodebox", a, shift: e.shiftKey };
    setNodeBox({ a, b: a });
  };

  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const p = pos(e);
    if (g.kind === "region") {
      // Box: keep the start corner. Knife line: start and end. Lasso: every point.
      const a = g.pts[0];
      if (tool === "box") g.pts = [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }];
      else if (tool === "knifeLine") g.pts = [a, p];
      else g.pts.push(p);
      setRegion([...g.pts]);
    } else if (g.kind === "nodebox") {
      setNodeBox({ a: g.a, b: p });
    } else if (g.kind === "move" || g.kind === "text") {
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
      if (!g.moved && Math.hypot(dx, dy) < 2 * unit) return;
      g.moved = true;
      // A point drag moves every selected point; a handle drag moves just that handle.
      const next = g.base.map((sp, si) => ({
        ...sp,
        nodes: sp.nodes.map((n, ni) => {
          if (g.part === "point") return g.keys.has(nodeKey(si, ni)) ? { ...n, x: n.x + dx, y: n.y + dy } : n;
          if (si !== g.sub || ni !== g.idx) return n;
          return g.part === "in" ? { ...n, ix: n.ix + dx, iy: n.iy + dy } : { ...n, ox: n.ox + dx, oy: n.oy + dy };
        }),
      }));
      const d = buildPath(next);
      ed.preview(ed.shapes.map((s) => (s.id === nodeShape.id ? { ...s, d } : s)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    if (g.kind === "node") {
      if (g.moved) return ed.commitPreview();
      // A plain click on one of several selected points selects just that one.
      if (g.part === "point" && g.wasSelected && !g.shift && ed.nodeSel.size > 1) ed.setNodeSel(new Set([nodeKey(g.sub, g.idx)]));
      return;
    }
    if (g.kind === "nodebox") {
      const b = pos(e);
      setNodeBox(null);
      const x0 = Math.min(g.a.x, b.x), x1 = Math.max(g.a.x, b.x), y0 = Math.min(g.a.y, b.y), y1 = Math.max(g.a.y, b.y);
      const next = new Set(g.shift ? ed.nodeSel : []);
      if (Math.max(x1 - x0, y1 - y0) > 3 * unit) {
        subs?.forEach((sp, si) => sp.nodes.forEach((n, ni) => {
          if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) next.add(nodeKey(si, ni));
        }));
      }
      ed.setNodeSel(next);
      return;
    }
    if (g.kind === "region") {
      setRegion(null);
      const pts = g.pts;
      if (!tool) return;
      if (tool === "knifeLine" ? pts.length >= 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) > 3 * unit : pts.length >= 3) {
        onRegion(pts, tool);
      }
      return;
    }
    if (g.kind === "text") {
      if (g.moved && live && ed.selectedText) ed.updateText(g.id, { x: ed.selectedText.x + live[4], y: ed.selectedText.y + live[5] });
      setLive(null);
      return;
    }
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
    ed.setNodeSel(new Set());
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
  // Curve handles are shown for the selected points (up to 30, to keep it readable).
  const handleNodes = subs && ed.nodeSel.size <= 30
    ? [...ed.nodeSel].flatMap((k) => {
        const [si, ni] = k.split(":").map(Number);
        const n = subs[si]?.nodes[ni];
        return n ? [{ si, ni, n }] : [];
      })
    : [];
  const hoverShape = hover !== null && !tool && !nodeShape && !drag.current ? ed.shapes.find((s) => s.id === hover) : null;

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
      data-points={nodeShape ? pointCount : undefined}
    >
      {ed.shapes.map((s) => (
        <path
          key={s.id}
          data-shape-id={s.id}
          d={s.d}
          fill={s.fill}
          stroke={s.fill}
          transform={ed.selection.has(s.id) ? liveAttr : undefined}
          onPointerDown={(e) => onShapeDown(e, s.id)}
          onPointerEnter={() => setHover(s.id)}
          onPointerLeave={() => setHover((h) => (h === s.id ? null : h))}
        />
      ))}

      {/* Text objects sit on top of the traced shapes. */}
      {ed.texts.map((t) => {
        const entry = fonts.find((f) => f.id === t.fontId);
        if (!entry) return null; // font still loading
        const layout = getLayout(t, entry);
        const isSel = ed.selectedText?.id === t.id;
        const b = layout.box;
        return (
          <g key={"t" + t.id} data-text-id={t.id} className={"text-obj" + (isSel ? " sel" : "")}
            transform={isSel ? liveAttr : undefined} onPointerDown={(e) => onTextDown(e, t.id)}>
            {/* An invisible box makes thin or hollow text easy to click. */}
            <rect className="text-hit" x={b.x} y={b.y} width={b.w} height={b.h} />
            {textParts(t, layout).map((part, i) => (
              <path
                key={i} d={part.d} fill={part.fill} opacity={part.opacity}
                transform={part.dx || part.dy ? `translate(${part.dx} ${part.dy})` : undefined}
                stroke={part.stroke} strokeWidth={part.strokeWidth ? part.strokeWidth * 2 : undefined}
                strokeLinejoin="round"
              />
            ))}
            {isSel && <rect className="text-box" x={b.x} y={b.y} width={b.w} height={b.h} data-testid="text-box" />}
          </g>
        );
      })}

      {/* Hover: outline of the shape under the mouse. */}
      {hoverShape && !ed.selection.has(hoverShape.id) && (
        <path className="hover-outline" data-testid="hover-outline" d={hoverShape.d} />
      )}

      {/* Node editing: dragging on the picture draws a selection box. */}
      {nodeShape && !tool && (
        <rect className="node-catcher" data-testid="node-catcher" x={0} y={0} width={W} height={H} onPointerDown={onNodeBoxDown} />
      )}

      {/* Selection: an outline around each selected shape. */}
      {ed.selected.map((s) => (
        <path key={"sel" + s.id} className="sel-outline" d={s.d} transform={liveAttr} />
      ))}
      {/* Node editing: a wide invisible edge so a double-click on the outline is easy to hit. */}
      {nodeShape && (
        <path
          className="seg-hit"
          data-testid="seg-hit"
          d={nodeShape.d}
          onPointerDown={(e) => e.stopPropagation() /* a click here is not a click on empty space */}
          onDoubleClick={onOutlineDouble}
        />
      )}

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

      {/* Node editing: every point, plus the curve handles of the selected points. */}
      {subs && (
        <g className="nodes" data-testid="nodes">
          {handleNodes.map(({ si, ni, n }) => (
            <g key={"h" + si + "-" + ni}>
              <line x1={n.x} y1={n.y} x2={n.x + n.ix} y2={n.y + n.iy} />
              <line x1={n.x} y1={n.y} x2={n.x + n.ox} y2={n.y + n.oy} />
              <circle className="handle curve" cx={n.x + n.ix} cy={n.y + n.iy} r={hs * 0.45}
                onPointerDown={(e) => onNodeDown(e, si, ni, "in")} />
              <circle className="handle curve" cx={n.x + n.ox} cy={n.y + n.oy} r={hs * 0.45}
                onPointerDown={(e) => onNodeDown(e, si, ni, "out")} />
            </g>
          ))}
          {subs.map((sp, si) =>
            sp.nodes.map((n, ni) => (
              <rect
                key={si + "-" + ni}
                data-node={nodeKey(si, ni)}
                className={"handle node" + (ed.nodeSel.has(nodeKey(si, ni)) ? " active" : "")}
                x={n.x - hs * 0.4}
                y={n.y - hs * 0.4}
                width={hs * 0.8}
                height={hs * 0.8}
                onPointerDown={(e) => onNodeDown(e, si, ni, "point")}
                onDoubleClick={(e) => removeNode(e, si, ni)}
              />
            )),
          )}
          {nodeBox && (
            <rect
              className="node-box"
              x={Math.min(nodeBox.a.x, nodeBox.b.x)}
              y={Math.min(nodeBox.a.y, nodeBox.b.y)}
              width={Math.abs(nodeBox.b.x - nodeBox.a.x)}
              height={Math.abs(nodeBox.b.y - nodeBox.a.y)}
            />
          )}
        </g>
      )}

      {/* Tools that draw on the picture: lettering box/lasso, knife line/lasso. */}
      {tool && (
        <>
          <rect className={"region-catcher" + (tool.startsWith("knife") ? " knife" : "")} data-testid="region-catcher"
            x={0} y={0} width={W} height={H} onPointerDown={onRegionDown} />
          {region && region.length > 1 && (tool === "knifeLine"
            ? <line className="knife-line" x1={region[0].x} y1={region[0].y} x2={region[1].x} y2={region[1].y} />
            : <polygon className={"region-shape" + (tool === "knifeLasso" ? " knife" : "")} points={region.map((p) => `${p.x},${p.y}`).join(" ")} />)}
        </>
      )}
    </svg>
  );
}

/** Size of a shape in drawing units, for the layers list. */
export const shapeSize = (d: string) => {
  const b = bounds(d);
  return `${Math.round(b.w)} × ${Math.round(b.h)}`;
};
