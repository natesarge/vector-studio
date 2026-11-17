// "Replace lettering": find the traced letters inside a region the user drew,
// and work out where real text should go so it matches their position, size
// and slope or arc. A port of the fitting maths in reference/textify.py.
//
// Because shapes are stacked, erasing is simple: removing the letter shapes
// lets the colour underneath show through, which is the surrounding colour.

import { bounds, measure, outlinePoints, unionBox } from "../editor/geom";
import type { DocShape } from "../editor/useEditor";
import type { TextObj } from "./layout";

export interface Pt { x: number; y: number }

function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Value below which `p` percent of the numbers fall. */
function percentile(sorted: Float64Array, p: number): number {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const sortedCopy = (a: number[]) => Float64Array.from(a).sort();

export interface LetteringMatch {
  /** Shapes to delete (the old letters and the holes inside them). */
  removeIds: Set<number>;
  /** Settings for the replacement text object. */
  fit: Partial<TextObj>;
  layout: "straight" | "arc";
}

export function findLettering(shapes: DocShape[], region: Pt[]): LetteringMatch | null {
  // 1. Which shapes lie inside the region? (At least 90% of their outline.)
  const inside = shapes.filter((s, i) => {
    if (i === 0) return false; // never the bottom shape
    const pts = outlinePoints(s.d, 24);
    return pts.length > 0 && pts.filter((p) => insidePolygon(p, region)).length >= pts.length * 0.9;
  });
  if (!inside.length) return null;

  // 2. The lettering colour is the one covering the most area. Other colours
  //    inside are holes in letters (the middle of an O, A, P...).
  const areaByFill = new Map<string, number>();
  for (const s of inside) areaByFill.set(s.fill, (areaByFill.get(s.fill) ?? 0) + measure(s.d).area);
  const textColor = [...areaByFill].sort((a, b) => b[1] - a[1])[0][0];

  // 3. Paint the letters into a small black-and-white picture and collect the
  //    position of every "ink" pixel, like textify.py does with its label image.
  const box = unionBox(inside.map((s) => bounds(s.d)))!;
  const k = Math.min(1, 700 / Math.max(box.w, box.h));
  const cw = Math.max(1, Math.ceil(box.w * k)), ch = Math.max(1, Math.ceil(box.h * k));
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000"; g.fillRect(0, 0, cw, ch);
  g.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
  for (const s of inside) {
    g.fillStyle = s.fill === textColor ? "#fff" : "#000";
    g.fill(new Path2D(s.d));
  }
  const px = g.getImageData(0, 0, cw, ch).data;
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (px[(y * cw + x) * 4] > 127) { xs.push(box.x + (x + 0.5) / k); ys.push(box.y + (y + 0.5) / k); }
  const n = xs.length;
  if (n < 20) return null;

  // 4. Middle of the ink in each narrow vertical strip: the "spine" of the text.
  const strip = Math.max(12, box.w / 60);
  const cols = new Map<number, { lo: number; hi: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const b = Math.round(xs[i] / strip);
    const c = cols.get(b);
    if (!c) cols.set(b, { lo: ys[i], hi: ys[i], count: 1 });
    else { c.lo = Math.min(c.lo, ys[i]); c.hi = Math.max(c.hi, ys[i]); c.count++; }
  }
  const mx: number[] = [], my: number[] = [];
  const minCount = Math.max(2, 20 * k * k);
  for (const [b, c] of cols) if (c.count > minCount) { mx.push(b * strip); my.push((c.lo + c.hi) / 2); }

  // 5. Straight fit: best line through all the ink (least squares).
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  const m = den ? (n * sxy - sx * sy) / den : 0;
  const b = (sy - m * sx) / n;
  const xSorted = sortedCopy(xs);
  const x0 = percentile(xSorted, 0.2), x1 = percentile(xSorted, 99.8);
  const straight: Partial<TextObj> = {
    fill: textColor, curve: "none", rotation: 0,
    x: (x0 + x1) / 2, y: m * ((x0 + x1) / 2) + b,
    fitWidth: x1 - x0, slope: (Math.atan(m) * 180) / Math.PI,
  };
  const removeIds = new Set(inside.map((s) => s.id));
  if (mx.length < 5) return { removeIds, fit: straight, layout: "straight" };

  // 6. Arc fit: best circle through the spine points (least squares).
  //    Solve [2x 2y 1] . [cx cy c] = x^2 + y^2 with the normal equations.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
  for (let i = 0; i < mx.length; i++) {
    const row = [2 * mx[i], 2 * my[i], 1], v = mx[i] * mx[i] + my[i] * my[i];
    for (let r = 0; r < 3; r++) { rhs[r] += row[r] * v; for (let c = 0; c < 3; c++) A[r][c] += row[r] * row[c]; }
  }
  const sol = solve3(A, rhs);
  if (!sol) return { removeIds, fit: straight, layout: "straight" };
  const [ccx, ccy] = sol;
  const rr = sortedCopy(xs.map((x, i) => Math.hypot(x - ccx, ys[i] - ccy)));
  const R = (percentile(rr, 99.5) + percentile(rr, 0.5)) / 2;
  const thickness = percentile(rr, 99.5) - percentile(rr, 0.5); // roughly the letter height

  // How well does each model follow the spine?
  const mLine = lineFit(mx, my);
  let errLine = 0, errArc = 0;
  for (let i = 0; i < mx.length; i++) {
    errLine += (my[i] - (mLine.m * mx[i] + mLine.b)) ** 2;
    errArc += (Math.hypot(mx[i] - ccx, my[i] - ccy) - R) ** 2;
  }
  const chord = x1 - x0;
  const sagitta = R > chord / 2 ? R - Math.sqrt(R * R - (chord / 2) ** 2) : R; // how far the arc bows
  const isArc = errArc < errLine * 0.5 && sagitta > thickness * 0.15 && R < chord * 6;
  if (!isArc) return { removeIds, fit: straight, layout: "straight" };

  const top = ccy > sy / n; // circle centre below the text = text arches over the top
  const ang = sortedCopy(xs.map((x, i) => Math.atan2(ys[i] - ccy, x - ccx)));
  const a0 = percentile(ang, 0.2), a1 = percentile(ang, 99.8), amid = (a0 + a1) / 2;
  const arc: Partial<TextObj> = {
    fill: textColor, curve: "circle", radius: R, curveDown: !top, slope: 0,
    x: ccx + R * Math.cos(amid), y: ccy + R * Math.sin(amid),
    // Upright text sits at the very top (-90 degrees) or very bottom (+90).
    rotation: ((amid * 180) / Math.PI) + (top ? 90 : -90),
    fitWidth: R * (a1 - a0),
  };
  return { removeIds, fit: arc, layout: "arc" };
}

function lineFit(x: number[], y: number[]) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const den = n * sxx - sx * sx;
  const m = den ? (n * sxy - sx * sy) / den : 0;
  return { m, b: (sy - m * sx) / n };
}

/** Solve a 3x3 linear system by Gaussian elimination (null if it has no single answer). */
function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
