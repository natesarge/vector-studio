// Shape operations built on Paper.js boolean maths. Used by the processing
// worker (flatten overlaps, border rings, clipping) and by the editor (break
// apart, knife, merging, defect cleanup, point editing). Everything takes and
// returns SVG path text ("d"), so callers never deal with Paper objects.

import paper from "paper/dist/paper-core";
import { ensurePaper, pathItem } from "./geom";

export interface Pt { x: number; y: number }

// Paper.js can round path text to a chosen number of decimals; its type
// definitions just do not mention the option.
type WithPathData = { getPathData(matrix: paper.Matrix | null, precision: number): string };
/** Path text with 2 decimals (plenty at pixel scale, keeps files small). */
export const dOf = (it: paper.PathItem | paper.Path) => (it as unknown as WithPathData).getPathData(null, 2);
export const areaOf = (it: paper.PathItem | null) =>
  it ? Math.abs((it as paper.PathItem & { area: number }).area ?? 0) : 0;

/** The separate closed loops of a path (outer edges and holes alike). */
function loops(it: paper.Item): paper.Path[] {
  if (it instanceof paper.CompoundPath) return it.children as paper.Path[];
  if (it instanceof paper.Path) return [it];
  return [];
}

// ---------------------------------------------------------------- pieces
/** One solid piece of a shape: an outer edge plus the holes inside it. */
export interface Piece {
  d: string;
  /** Filled area (holes subtracted). */
  area: number;
  /** Total outline length, holes included. */
  length: number;
  outer: paper.Path;
  holes: paper.Path[];
}

function makePiece(outer: paper.Path, holes: paper.Path[]): Piece {
  const o = outer.clone({ insert: false }) as paper.Path;
  // Holes must wind the opposite way to their outer edge to stay empty.
  const hs = holes.map((h) => {
    const c = h.clone({ insert: false }) as paper.Path;
    if (c.clockwise === o.clockwise) c.reverse();
    return c;
  });
  const area = Math.abs(o.area) - hs.reduce((a, h) => a + Math.abs(h.area), 0);
  return {
    d: [o, ...hs].map(dOf).join(""),
    area,
    length: o.length + hs.reduce((a, h) => a + h.length, 0),
    outer: o,
    holes: hs,
  };
}

/**
 * Split a shape into its solid pieces. A loop is a hole when an odd number of
 * other loops surround it; each hole goes with the smallest piece around it.
 */
export function piecesOf(it: paper.PathItem): Piece[] {
  const ls = loops(it).filter((p) => p.segments.length > 1 && Math.abs(p.area) > 0.01);
  const n = ls.length;
  if (n === 0) return [];
  if (n === 1) return [makePiece(ls[0], [])];
  const area = ls.map((p) => Math.abs(p.area));
  const pt = ls.map((p) => p.interiorPoint);
  const around = ls.map((_, i) =>
    ls.map((_, j) => j).filter((j) => j !== i && area[j] > area[i] && ls[j].bounds.contains(pt[i]) && ls[j].contains(pt[i])),
  );
  const depth = around.map((a) => a.length);
  const holesOf = new Map<number, paper.Path[]>();
  for (let i = 0; i < n; i++) if (depth[i] % 2 === 0) holesOf.set(i, []);
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) continue;
    const parent = around[i].filter((j) => depth[j] === depth[i] - 1).sort((a, b) => area[a] - area[b])[0];
    if (parent !== undefined) holesOf.get(parent)?.push(ls[i]);
  }
  return [...holesOf].map(([i, hs]) => makePiece(ls[i], hs));
}

/** Break a shape into one path per solid piece (holes stay with their piece). */
export const breakApart = (d: string): string[] => piecesOf(pathItem(d)).map((p) => p.d);

/** Remove holes smaller than `maxArea` (all holes when Infinity). */
export function fillHoles(d: string, maxArea = Infinity): string {
  const it = pathItem(d);
  if (loops(it).length < 2) return d;
  return piecesOf(it).map((p) => makePiece(p.outer, p.holes.filter((h) => Math.abs(h.area) >= maxArea)).d).join("");
}

// ---------------------------------------------------------------- neighbours
/** Points spread along every loop of a shape. */
function samplePoints(it: paper.PathItem, perLoop = 16): paper.Point[] {
  const pts: paper.Point[] = [];
  for (const p of loops(it)) {
    const len = p.length;
    if (!len) continue;
    for (let i = 0; i < perLoop; i++) {
      const q = p.getPointAt((len * i) / perLoop);
      if (q) pts.push(q);
    }
  }
  return pts;
}

/**
 * Which candidate shape touches `target` the most? Counts outline points of
 * the target that lie inside or within `tol` of each candidate. -1 if none.
 */
export function bestNeighbor(target: paper.PathItem, cands: (paper.PathItem | null)[], tol = 2): number {
  const pts = samplePoints(target);
  const tb = target.bounds.expand(tol * 2);
  let best = -1, bestN = 0;
  cands.forEach((c, i) => {
    if (!c || !c.bounds.intersects(tb)) return;
    let k = 0;
    for (const p of pts) {
      if (c.contains(p)) { k++; continue; }
      const q = c.getNearestPoint(p);
      if (q && q.getDistance(p) <= tol) k++;
    }
    if (k > bestN) { bestN = k; best = i; }
  });
  return best;
}

/**
 * Remove the shapes at `remove` without leaving gaps: each one is merged into
 * the neighbouring shape it touches most. Shapes enclosed only by other
 * removed shapes are handled in later passes, once their surroundings merged.
 */
export function absorb<T extends { d: string }>(shapes: T[], remove: ReadonlySet<number>): T[] {
  const items: (paper.PathItem | null)[] = shapes.map((s) => pathItem(s.d));
  const next = shapes.slice();
  const pending = new Set(remove);
  for (let pass = 0; pass < 4 && pending.size; pass++) {
    for (const i of [...pending]) {
      const b = bestNeighbor(items[i]!, items.map((it, j) => (pending.has(j) ? null : it)));
      if (b < 0) continue;
      try {
        const u = items[b]!.unite(items[i]!, { insert: false }) as paper.PathItem;
        items[b] = u;
        next[b] = { ...next[b], d: dOf(u) };
      } catch {
        // could not merge: the piece is simply dropped
      }
      pending.delete(i);
      items[i] = null;
    }
  }
  return next.filter((_, i) => !remove.has(i));
}

// ---------------------------------------------------------------- flatten overlaps
/**
 * Turn stacked shapes (bigger shapes painted underneath smaller ones) into
 * shapes that do not overlap: every upper shape is cut out of the shapes
 * below it, so each visible area belongs to exactly one shape. Leftover
 * slivers (smaller than speckle x speckle, or thinner than 2.5 px) from the
 * cutting are merged into their neighbour.
 */
export async function flattenShapes<T extends { d: string }>(
  shapes: T[], speckle: number, tick: (f: number) => Promise<void>,
): Promise<T[]> {
  ensurePaper();
  const n = shapes.length;
  const orig = shapes.map((s) => pathItem(s.d));
  const box = orig.map((o) => o.bounds);
  const samples = orig.map((o) => samplePoints(o, 6));
  const out: paper.PathItem[] = [];
  const cut: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let r: paper.PathItem = orig[i];
    const done: number[] = [];
    for (let j = i + 1; j < n; j++) {
      if (!box[i].intersects(box[j])) continue;
      // A shape lying inside one already cut away needs no cutting itself.
      if (done.some((k) => box[k].contains(box[j]) && samples[j].every((p) => orig[k].contains(p)))) continue;
      try {
        r = r.subtract(orig[j], { insert: false }) as paper.PathItem;
      } catch {
        // keep going with what we have
      }
      done.push(j);
      if (areaOf(r) < 1) break; // completely covered
    }
    out.push(r);
    cut.push(done.length > 0);
    await tick(((i + 1) / n) * 0.8);
  }

  // Separate each cut shape into pieces; slivers are set aside to be merged.
  const minArea = speckle * speckle;
  const kept: T[] = [];
  const slivers: T[] = [];
  out.forEach((r, i) => {
    if (!cut[i]) return kept.push(shapes[i]);
    const ps = piecesOf(r);
    const good = ps.filter((p) => p.area >= minArea && (2 * p.area) / p.length >= 2.5);
    const bad = ps.filter((p) => !good.includes(p));
    if (good.length) kept.push({ ...shapes[i], d: good.map((p) => p.d).join("") });
    for (const p of bad) if (p.area > 0.5) slivers.push({ ...shapes[i], d: p.d });
  });
  await tick(0.9);
  const all = [...kept, ...slivers];
  const remove = new Set(slivers.map((_, k) => kept.length + k));
  return absorb(all, remove);
}

/** Trim every shape to the inside of `clipD` (shapes fully outside are dropped). */
export function clipTo<T extends { d: string }>(shapes: T[], clipD: string): T[] {
  const clip = pathItem(clipD);
  const cb = clip.bounds;
  return shapes.flatMap((s) => {
    const it = pathItem(s.d);
    const b = it.bounds;
    if (!b.intersects(cb)) return [];
    if (cb.contains(b) && samplePoints(it, 12).every((p) => clip.contains(p))) return [s];
    try {
      const r = it.intersect(clip, { insert: false }) as paper.PathItem;
      return areaOf(r) > 1 ? [{ ...s, d: dOf(r) }] : [];
    } catch {
      return [s];
    }
  });
}

// ---------------------------------------------------------------- rings
/** The design's outer outline as a formula (circle/ellipse, rounded rectangle) or a path. */
export type OutlineShape =
  | { kind: "ellipse"; cx: number; cy: number; a: number; b: number; angle: number }
  | { kind: "rrect"; cx: number; cy: number; hw: number; hh: number; r: number; angle: number }
  | { kind: "path"; d: string };

/**
 * The outline shrunk inward by `inset` (0 = the outline itself). Circles and
 * rounded rectangles stay exact; free shapes use a point-by-point offset.
 */
export function insetOutline(o: OutlineShape, inset: number, offset: (d: string, dist: number) => string): string | null {
  ensurePaper();
  if (o.kind === "path") return inset > 0 ? offset(o.d, -inset) || null : o.d;
  const deg = (o.angle * 180) / Math.PI;
  const centre = new paper.Point(o.cx, o.cy);
  let p: paper.Path;
  if (o.kind === "ellipse") {
    const a = o.a - inset, b = o.b - inset;
    if (a <= 1 || b <= 1) return null;
    p = new paper.Path.Ellipse({ center: centre, radius: [a, b], insert: false });
  } else {
    const hw = o.hw - inset, hh = o.hh - inset;
    if (hw <= 1 || hh <= 1) return null;
    p = new paper.Path.Rectangle({
      rectangle: new paper.Rectangle(o.cx - hw, o.cy - hh, hw * 2, hh * 2),
      radius: Math.max(0, o.r - inset),
      insert: false,
    });
  }
  if (deg) p.rotate(deg, centre);
  return dOf(p);
}

/** The band between an outer and an inner edge, as one shape with a hole. */
export function ringBetween(outerD: string, innerD: string | null): string {
  const outer = pathItem(outerD);
  if (!innerD) return dOf(outer);
  return dOf(outer.subtract(pathItem(innerD), { insert: false }) as paper.PathItem);
}

// ---------------------------------------------------------------- knife
/**
 * Cut a shape in two. "line": along the straight line through the first and
 * last points (extended across the whole shape). "lasso": along the closed
 * loop drawn. Returns [outside, inside], or null if the cut missed.
 */
export function knife(d: string, pts: Pt[], mode: "line" | "lasso"): [string, string] | null {
  const it = pathItem(d);
  let cutter: paper.Path;
  if (mode === "line") {
    const a = new paper.Point(pts[0].x, pts[0].y), b = new paper.Point(pts[pts.length - 1].x, pts[pts.length - 1].y);
    const u = b.subtract(a);
    if (u.length < 1) return null;
    const dir = u.normalize(), nrm = new paper.Point(-dir.y, dir.x);
    const big = (it.bounds.width + it.bounds.height + a.getDistance(it.bounds.center)) * 4;
    const p0 = a.subtract(dir.multiply(big)), p1 = b.add(dir.multiply(big));
    cutter = new paper.Path({ segments: [p0, p1, p1.add(nrm.multiply(big)), p0.add(nrm.multiply(big))], closed: true, insert: false });
  } else {
    if (pts.length < 3) return null;
    cutter = new paper.Path({ segments: pts.map((p) => new paper.Point(p.x, p.y)), closed: true, insert: false });
  }
  const inside = it.intersect(cutter, { insert: false }) as paper.PathItem;
  const outside = it.subtract(cutter, { insert: false }) as paper.PathItem;
  if (areaOf(inside) < 1 || areaOf(outside) < 1) return null;
  return [dOf(outside), dOf(inside)];
}

// ---------------------------------------------------------------- points (node editing)
/** Point keys are "loop:index", matching parseNodes() in geom.ts. */
export const nodeKey = (loop: number, index: number) => `${loop}:${index}`;

/** Delete the listed points. Loops left with too few points disappear. */
export function removeNodes(d: string, keys: ReadonlySet<string>): string {
  const it = pathItem(d);
  loops(it).forEach((p, li) => {
    for (let i = p.segments.length - 1; i >= 0; i--) if (keys.has(nodeKey(li, i))) p.removeSegment(i);
  });
  for (const p of loops(it).slice()) if (p.segments.length < (p.closed ? 3 : 2)) p.remove();
  return loops(it).length ? dOf(it) : "";
}

/**
 * Smooth only the selected points. Each run of neighbouring selected points
 * is refitted with fewer, smoother curves (tolerance = how loosely); the
 * unselected points either side stay exactly where they are. A single
 * selected point is turned into a smooth curve point. Returns the new path
 * and the keys of the points that replaced the selection.
 */
export function smoothNodes(d: string, keys: ReadonlySet<string>, tolerance: number): { d: string; keys: Set<string> } {
  if (tolerance <= 0 || !keys.size) return { d, keys: new Set(keys) };
  const it = pathItem(d);
  const fresh = new Set<paper.Segment>();
  loops(it).forEach((path, li) => {
    let sel = path.segments.map((_, i) => keys.has(nodeKey(li, i)));
    if (!sel.some(Boolean)) return;
    if (sel.every(Boolean)) {
      path.simplify(tolerance);
      path.segments.forEach((s) => fresh.add(s));
      return;
    }
    // On a closed loop, start at an unselected point so no run wraps around.
    if (path.closed) {
      const u = sel.indexOf(false);
      if (u > 0) {
        path.addSegments(path.removeSegments(0, u));
        sel = [...sel.slice(u), ...sel.slice(0, u)];
      }
    }
    const runs: [number, number][] = [];
    for (let i = 0; i < sel.length; i++) {
      if (!sel[i]) continue;
      let j = i;
      while (j + 1 < sel.length && sel[j + 1]) j++;
      runs.push([i, j]);
      i = j;
    }
    for (const [s, e] of runs.reverse()) {
      const last = path.segments.length - 1;
      const a = Math.max(0, s - 1), b = Math.min(last, e + 1); // unselected anchors either side
      const sub = new paper.Path({ segments: path.segments.slice(a, b + 1).map((g) => g.clone()), insert: false });
      if (e > s) sub.simplify(tolerance);
      else sub.segments[s - a].smooth({ type: "catmull-rom" });
      if (a < s) path.segments[a].handleOut = sub.firstSegment.handleOut;
      if (b > e) path.segments[b].handleIn = sub.lastSegment.handleIn;
      const inner = sub.segments.slice(a < s ? 1 : 0, b > e ? sub.segments.length - 1 : sub.segments.length);
      path.removeSegments(s, e + 1);
      path.insertSegments(s, inner.map((g) => g.clone()));
      for (let k = 0; k < inner.length; k++) fresh.add(path.segments[s + k]);
    }
  });
  const out = new Set<string>();
  loops(it).forEach((p, li) => p.segments.forEach((s, i) => fresh.has(s) && out.add(nodeKey(li, i))));
  return { d: dOf(it), keys: out };
}
