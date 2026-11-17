// Geometry helpers built on Paper.js. Paper is used only as a maths library
// here (nothing is drawn with it): every function takes SVG path text ("d")
// and returns numbers or new path text, so the rest of the app stays simple.

import paper from "paper/dist/paper-core";

let ready = false;
function setup() {
  if (ready) return;
  paper.setup(new paper.Size(1, 1));
  paper.settings.insertItems = false; // items are temporary; do not keep them
  ready = true;
}

function item(d: string): paper.CompoundPath {
  setup();
  return new paper.CompoundPath({ pathData: d, insert: false });
}

/** SVG-style matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Bounding boxes are asked for often (every redraw), so remember them.
const boxCache = new Map<string, Box>();
export function bounds(d: string): Box {
  let b = boxCache.get(d);
  if (!b) {
    const r = item(d).bounds;
    b = { x: r.x, y: r.y, w: r.width, h: r.height };
    if (boxCache.size > 2000) boxCache.clear();
    boxCache.set(d, b);
  }
  return b;
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Apply a matrix to a path and return the new path text. */
export function transformPath(d: string, m: Matrix): string {
  const it = item(d);
  it.transform(new paper.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  return it.pathData;
}

/** Turn an SVG "translate(x,y)" attribute into a matrix (identity if absent). */
export function parseTranslate(transform: string | undefined): Matrix | null {
  const m = transform && /translate\(\s*([-\d.eE]+)[\s,]+([-\d.eE]+)\s*\)/.exec(transform);
  return m ? [1, 0, 0, 1, Number(m[1]), Number(m[2])] : null;
}

/** Fewer points, same general shape. Larger tolerance = simpler. */
export function simplifyPath(d: string, tolerance: number): string {
  if (tolerance <= 0) return d;
  const it = item(d);
  for (const p of it.children as paper.Path[]) p.simplify(tolerance);
  return it.pathData;
}

/** Make every point a smooth curve point. */
export function smoothPath(d: string): string {
  const it = item(d);
  for (const p of it.children as paper.Path[]) p.smooth({ type: "continuous" });
  return it.pathData;
}

/** Boolean union of two shapes (null if Paper could not compute it). */
export function unitePaths(a: string, b: string): string | null {
  try {
    const u = item(a).unite(item(b), { insert: false }) as paper.PathItem;
    return u.pathData || null;
  } catch {
    return null;
  }
}

/** Area and outline length, used to spot specks and slivers. */
export function measure(d: string): { area: number; length: number } {
  const it = item(d);
  return { area: Math.abs(it.area), length: it.length };
}

export function contains(d: string, x: number, y: number): boolean {
  return item(d).contains(new paper.Point(x, y));
}

/** `n` points spread evenly along each outline of a shape. */
export function outlinePoints(d: string, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const p of item(d).children as paper.Path[]) {
    const len = p.length;
    for (let i = 0; i < n; i++) {
      const q = p.getPointAt((len * i) / n);
      if (q) pts.push({ x: q.x, y: q.y });
    }
  }
  return pts;
}

/** A point guaranteed to be inside the shape. */
export function interiorPoint(d: string): { x: number; y: number } {
  const p = item(d).interiorPoint;
  return { x: p.x, y: p.y };
}

/** Add a new point on the outline at the place nearest to (x, y). */
export function insertNode(d: string, x: number, y: number): string {
  const it = item(d);
  const pt = new paper.Point(x, y);
  let best: paper.CurveLocation | null = null;
  for (const p of it.children as paper.Path[]) {
    const loc = p.getNearestLocation(pt);
    if (loc && (!best || loc.distance < best.distance)) best = loc;
  }
  if (!best) return d;
  best.path.divideAt(best);
  return it.pathData;
}

// ---------------------------------------------------------------- nodes
/** One point of a path. Handle positions are relative to the point. */
export interface Node {
  x: number; y: number;
  ix: number; iy: number; // incoming handle
  ox: number; oy: number; // outgoing handle
}
export interface SubPath {
  closed: boolean;
  nodes: Node[];
}

/** Break a path into its points and curve handles for node editing. */
export function parseNodes(d: string): SubPath[] {
  return (item(d).children as paper.Path[]).map((p) => ({
    closed: p.closed,
    nodes: p.segments.map((s) => ({
      x: s.point.x, y: s.point.y,
      ix: s.handleIn.x, iy: s.handleIn.y,
      ox: s.handleOut.x, oy: s.handleOut.y,
    })),
  }));
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** Rebuild path text from points and handles. */
export function buildPath(subs: SubPath[]): string {
  let d = "";
  for (const sp of subs) {
    const ns = sp.nodes;
    if (!ns.length) continue;
    d += `M${n3(ns[0].x)},${n3(ns[0].y)}`;
    const count = sp.closed ? ns.length : ns.length - 1;
    for (let i = 0; i < count; i++) {
      const a = ns[i], b = ns[(i + 1) % ns.length];
      if (!a.ox && !a.oy && !b.ix && !b.iy) d += `L${n3(b.x)},${n3(b.y)}`;
      else d += `C${n3(a.x + a.ox)},${n3(a.y + a.oy)} ${n3(b.x + b.ix)},${n3(b.y + b.iy)} ${n3(b.x)},${n3(b.y)}`;
    }
    if (sp.closed) d += "Z";
  }
  return d;
}

// ---------------------------------------------------------------- matrices
export const translate = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];

/** Scale by (sx, sy) keeping the point (ax, ay) where it is. */
export const scaleAbout = (sx: number, sy: number, ax: number, ay: number): Matrix =>
  [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay];

/** Rotate by `deg` degrees (clockwise on screen) around (cx, cy). */
export function rotateAbout(deg: number, cx: number, cy: number): Matrix {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
