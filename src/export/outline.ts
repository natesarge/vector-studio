// The outer outline of the whole drawing (for sticker die-cut lines), and a
// version of it pushed outward by a set distance (for a sticker's border).

import paper from "paper/dist/paper-core";
import { measure, outlinePoints } from "../editor/geom";
import { fillHoles } from "../editor/pathops";

const item = (d: string) => new paper.CompoundPath({ pathData: d, insert: false });

/**
 * One outline around everything: the union of all shapes, with holes removed.
 * Most shapes sit completely inside bigger ones and are skipped quickly.
 */
export function outerOutline(shapes: { d: string }[]): string {
  const sorted = shapes
    .map((s) => fillHoles(s.d)) // holes do not matter for the outer edge
    .map((d) => ({ d, area: measure(d).area })) // measure() also makes sure Paper is ready
    .sort((a, b) => b.area - a.area);
  let acc: paper.PathItem | null = null;
  for (const s of sorted) {
    if (!acc) { acc = item(s.d); continue; }
    const pts = outlinePoints(s.d, 12);
    if (pts.every((p) => acc!.contains(new paper.Point(p.x, p.y)))) continue; // already covered
    try {
      acc = acc.unite(item(s.d), { insert: false }) as paper.PathItem;
    } catch {
      // a shape Paper cannot combine is left out of the outline
    }
  }
  if (!acc) return "";
  const parts = (acc instanceof paper.CompoundPath ? acc.children : [acc]) as paper.Path[];
  // Outer loops all turn the same way as the biggest loop; holes turn the other way.
  const biggest = parts.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
  return parts.filter((p) => p.clockwise === biggest.clockwise && Math.abs(p.area) > 4).map((p) => p.pathData).join("");
}

/**
 * Push an outline outward by `dist` (a negative `dist` pulls it inward). The outline is turned into many short
 * straight pieces, each corner is moved along its outward direction, and any
 * overlaps this creates are cleaned up.
 */
export function offsetOutline(d: string, dist: number): string {
  if (!d || dist === 0) return d;
  let out = "";
  for (const src of item(d).children as paper.Path[]) {
    const flat = src.clone({ insert: false }) as paper.Path;
    flat.flatten(Math.max(0.25, Math.abs(dist) / 40));
    const pts = flat.segments.map((s) => s.point);
    const n = pts.length;
    if (n < 3) continue;
    // Which side is "outside" depends on the direction the loop was drawn in.
    let area2 = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area2 += a.x * b.y - b.x * a.y; }
    const sign = area2 > 0 ? 1 : -1;
    const moved: paper.Point[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
      const e1 = p.subtract(prev), e2 = next.subtract(p);
      if (e1.length < 1e-6 || e2.length < 1e-6) continue;
      const n1 = new paper.Point(e1.y, -e1.x).normalize(sign), n2 = new paper.Point(e2.y, -e2.x).normalize(sign);
      let bis = n1.add(n2);
      if (bis.length < 1e-6) bis = n1; else bis = bis.normalize();
      // Sharp corners stick out further; limit that so they do not spike.
      const k = Math.min(2, 1 / Math.max(0.2, bis.dot(n1)));
      moved.push(p.add(bis.multiply(dist * k)));
    }
    let grown: paper.PathItem = new paper.Path({ segments: moved, closed: true, insert: false });
    try {
      grown = grown.unite(grown, { insert: false }) as paper.PathItem; // removes self-overlaps
    } catch {
      // keep the raw offset if clean-up fails
    }
    const loops = (grown instanceof paper.CompoundPath ? grown.children : [grown]) as paper.Path[];
    if (!loops.length) continue;
    const main = loops.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
    main.simplify(Math.max(0.3, Math.abs(dist) / 60)); // back to smooth curves
    out += main.pathData;
  }
  return out;
}
