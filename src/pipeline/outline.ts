// Steps 6 and 7 of the pipeline (ports of snap_shape and find_border in
// reference/vectorize.py):
//
//  6. Outline snap: if the design's outer outline is nearly a perfect circle,
//     ellipse or rounded rectangle, replace the wobbly traced outline with the
//     perfect shape. "Nearly" is measured by overlap (IoU = shared area divided
//     by combined area).
//  7. Border band: find how wide the design's outer border is (the distance
//     from the edge where the mix of colours changes most) so it can be
//     redrawn as one clean, solid band.
//
// All measuring is done at base size; the final masks are drawn at working
// size from the fitted shape's formula, so their edges are perfectly smooth.

import type { RGB } from "./color";
import { gaussianBlur } from "./filters";
import type { Sizes } from "./types";

export type OutlineMode = "auto" | "circle" | "rect" | "off";

/** The outer shape of the design, in base-pixel units. */
export type Fit =
  | { kind: "ellipse"; cx: number; cy: number; a: number; b: number; angle: number }
  | { kind: "rrect"; cx: number; cy: number; hw: number; hh: number; r: number; angle: number }
  /** Free shape: a smoothed (or, for "raw", untouched) version of the traced outline. */
  | { kind: "free" | "raw"; soft: Float32Array; threshold: number };

export const fitName = (f: Fit) =>
  f.kind === "ellipse" ? (Math.abs(f.a - f.b) < 0.02 * f.a ? "circle" : "ellipse")
  : f.kind === "rrect" ? "rounded rectangle"
  : f.kind === "free" ? "free shape" : "as traced";

// ---------------------------------------------------------------- distance transform
/**
 * Exact distance from every "on" pixel to the nearest "off" pixel
 * (Felzenszwalb & Huttenlocher's two-pass algorithm).
 */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), dd = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s: number;
      do {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      dd[q] = (q - p) * (q - p) + f[p];
    }
  };
  for (let x = 0; x < w; x++) { // columns
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? INF : 0;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = dd[y];
  }
  for (let y = 0; y < h; y++) { // rows
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(Math.min(dd[x], 1e12));
  }
  return out;
}

// ---------------------------------------------------------------- shape tests
/** Signed distance to a rounded rectangle centred on the origin (negative inside). */
function sdRoundRect(u: number, v: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(u) - hw + r, qy = Math.abs(v) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

type Analytic = Extract<Fit, { kind: "ellipse" | "rrect" }>;

/**
 * Returns a fast test "is base-pixel point (x, y) inside the fitted shape,
 * shrunk inward by `inset`?". The rotation is worked out once, up front.
 */
function insideTest(f: Analytic, inset: number): (x: number, y: number) => boolean {
  const c = Math.cos(f.angle), s = Math.sin(f.angle), cx = f.cx, cy = f.cy;
  if (f.kind === "ellipse") {
    const a = f.a - inset, b = f.b - inset;
    if (a <= 0 || b <= 0) return () => false;
    const ia = 1 / (a * a), ib = 1 / (b * b);
    return (x, y) => {
      const dx = x - cx, dy = y - cy, u = dx * c + dy * s, v = dy * c - dx * s;
      return u * u * ia + v * v * ib <= 1;
    };
  }
  const { hw, hh, r } = f;
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    return sdRoundRect(dx * c + dy * s, dy * c - dx * s, hw, hh, r) <= -inset;
  };
}

/** Overlap score between a fitted shape and the mask (1 = identical). */
function iou(f: Analytic, mask: Uint8Array, w: number, h: number): number {
  const inside = insideTest(f, 0);
  let both = 0, either = 0;
  // Every second pixel is plenty for a score and four times faster.
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const a = mask[y * w + x] === 1, b = inside(x + 0.5, y + 0.5);
      if (a && b) both++;
      if (a || b) either++;
    }
  return either ? both / either : 0;
}

// ---------------------------------------------------------------- fitting
/** The ellipse with the same area, centre and spread as the mask. */
function fitEllipse(mask: Uint8Array, w: number, h: number): Extract<Fit, { kind: "ellipse" }> {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { n++; sx += x + 0.5; sy += y + 0.5; }
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  xx /= n; yy /= n; xy /= n;
  const mid = (xx + yy) / 2, dev = Math.hypot((xx - yy) / 2, xy);
  // For a filled ellipse the spread along an axis is (half-axis)^2 / 4.
  return { kind: "ellipse", cx, cy, a: 2 * Math.sqrt(mid + dev), b: 2 * Math.sqrt(Math.max(1e-6, mid - dev)), angle: 0.5 * Math.atan2(2 * xy, xx - yy) };
}

/** Smallest rotated rectangle around the mask (convex hull + rotating edges). */
function minAreaRect(mask: Uint8Array, w: number, h: number) {
  // Edge pixels only: leftmost and rightmost "on" pixel of every row.
  const pts: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) pts.push([lo, y], [lo, y + 1], [hi + 1, y], [hi + 1, y + 1]);
  }
  // Convex hull (Andrew's monotone chain).
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull: [number, number][] = [];
  for (const dir of [1, -1]) {
    const start = hull.length;
    for (let i = dir === 1 ? 0 : pts.length - 1; i >= 0 && i < pts.length; i += dir) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], pts[i]) <= 0) hull.pop();
      hull.push(pts[i]);
    }
    hull.pop();
  }
  let best = { area: Infinity, cx: 0, cy: 0, hw: 0, hh: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const r of hull) {
      const u = r[0] * ux + r[1] * uy, v = -r[0] * uy + r[1] * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
      best = { area, cx: mu * ux - mv * uy, cy: mu * uy + mv * ux, hw: (u1 - u0) / 2, hh: (v1 - v0) / 2, angle: Math.atan2(uy, ux) };
    }
  }
  // Keep the angle near zero so "width" really is the horizontal-ish side.
  while (best.angle > Math.PI / 4) { best.angle -= Math.PI / 2; [best.hw, best.hh] = [best.hh, best.hw]; }
  while (best.angle <= -Math.PI / 4) { best.angle += Math.PI / 2; [best.hw, best.hh] = [best.hh, best.hw]; }
  return best;
}

/** Best rounded rectangle: try 15 corner radii and keep the best overlap. */
function fitRoundRect(mask: Uint8Array, w: number, h: number) {
  const r0 = minAreaRect(mask, w, h);
  let best: Extract<Fit, { kind: "rrect" }> | null = null, bestScore = 0;
  for (let i = 0; i < 15; i++) {
    const frac = 0.02 + (0.28 * i) / 14;
    const f: Extract<Fit, { kind: "rrect" }> = { kind: "rrect", cx: r0.cx, cy: r0.cy, hw: r0.hw, hh: r0.hh, r: frac * 2 * Math.min(r0.hw, r0.hh), angle: r0.angle };
    const score = iou(f, mask, w, h);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return { fit: best!, score: bestScore };
}

/**
 * Decide the design's outer shape. `soft` is the 0..1 background mask at base
 * size and `threshold` the level that separates design from background.
 */
export function snapOutline(soft: Float32Array, threshold: number, w: number, h: number, mode: OutlineMode): Fit {
  if (mode === "off") return { kind: "raw", soft, threshold };
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = soft[i] > threshold ? 1 : 0;

  const ellipse = fitEllipse(mask, w, h);
  if (mode === "circle" || (mode === "auto" && iou(ellipse, mask, w, h) > 0.97)) return ellipse;
  const rr = fitRoundRect(mask, w, h);
  if (mode === "rect" || rr.score > 0.96) return rr.fit;

  // Neither fits: keep the traced outline but smooth it well.
  const smooth = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) smooth[i] = mask[i];
  gaussianBlur(smooth, w, h, 8);
  return { kind: "free", soft: smooth, threshold: 0.5 };
}

// ---------------------------------------------------------------- drawing masks at working size
/** Read a base-size float image at working pixel (X, Y) with interpolation. */
function sampler(field: Float32Array, w: number, h: number, W: number, H: number) {
  const kx = w / W, ky = h / H;
  return (X: number, Y: number) => {
    const fx = Math.max(0, Math.min(w - 1, (X + 0.5) * kx - 0.5)), fy = Math.max(0, Math.min(h - 1, (Y + 0.5) * ky - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const wx = fx - x0, wy = fy - y0;
    const top = field[y0 * w + x0] + (field[y0 * w + x1] - field[y0 * w + x0]) * wx;
    const bot = field[y1 * w + x0] + (field[y1 * w + x1] - field[y1 * w + x0]) * wx;
    return top + (bot - top) * wy;
  };
}

/**
 * Yes/no mask of the fitted shape at working size, shrunk inward by `inset`
 * base pixels (0 = the outline itself; the border width = inside the border).
 */
export function renderFit(fit: Fit, sz: Sizes, inset = 0): Uint8Array {
  const { bw, bh, W, H } = sz;
  const out = new Uint8Array(W * H);
  if (fit.kind === "ellipse" || fit.kind === "rrect") {
    const kx = bw / W, ky = bh / H;
    const inside = insideTest(fit, inset);
    for (let Y = 0; Y < H; Y++) {
      const y = (Y + 0.5) * ky;
      for (let X = 0; X < W; X++) if (inside((X + 0.5) * kx, y)) out[Y * W + X] = 1;
    }
    return out;
  }
  let field = fit.soft, level = fit.threshold;
  if (inset > 0) {
    // "At least `inset` pixels from the edge", read from a distance map.
    const mask = new Uint8Array(bw * bh);
    for (let i = 0; i < mask.length; i++) mask[i] = fit.soft[i] > fit.threshold ? 1 : 0;
    field = distanceTransform(mask, bw, bh);
    gaussianBlur(field, bw, bh, 1.5);
    level = inset;
  }
  const at = sampler(field, bw, bh, W, H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) if (at(X, Y) > level) out[Y * W + X] = 1;
  return out;
}

// ---------------------------------------------------------------- border band
export interface Border {
  /** Width of the detected border band, in base pixels. */
  width: number;
  /** Its colour: the brighter half of the band's pixels, median per channel. */
  color: RGB;
}

/**
 * Find the outer border band. `labels` is the colour number of every base
 * pixel, `k` how many colour numbers exist, `mask` the untouched design mask.
 */
export function findBorder(labels: Uint8Array, k: number, mask: Uint8Array, rgb: Uint8Array, w: number, h: number): Border | null {
  const dist = distanceTransform(mask, w, h);
  const D = Math.floor(Math.min(w, h) * 0.15);
  const step = 5, first = 3 + step;
  if (D - step <= first) return null;

  // Colour mix at each distance from the edge: comp[d][colour] = share of pixels.
  const comp = new Float64Array(D * k);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const d = Math.floor(dist[i]);
    if (d < D) comp[d * k + labels[i]]++;
  }
  for (let d = 0; d < D; d++) {
    let sum = 0;
    for (let c = 0; c < k; c++) sum += comp[d * k + c];
    if (sum > 0) for (let c = 0; c < k; c++) comp[d * k + c] /= sum;
  }
  // The border ends where the mix just outside differs most from just inside.
  let bestD = first, bestScore = -1;
  for (let d = first; d < D - step; d++) {
    let score = 0;
    for (let c = 0; c < k; c++) {
      let a = 0, b = 0;
      for (let j = 1; j <= step; j++) a += comp[(d - j) * k + c];
      for (let j = 0; j < step; j++) b += comp[(d + j) * k + c];
      score += Math.abs(a - b) / step;
    }
    if (score > bestScore) { bestScore = score; bestD = d; }
  }
  const width = bestD;

  // Border colour from the band's real pixels (ignoring its darker half, which
  // is mostly shading and stitching shadows).
  const lum: number[] = [], idx: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i] && dist[i] < width && dist[i] > width * 0.15) {
      idx.push(i);
      lum.push(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
    }
  }
  if (!idx.length) return null;
  const medLum = Float64Array.from(lum).sort()[lum.length >> 1];
  const color: RGB = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const vals: number[] = [];
    for (let j = 0; j < idx.length; j++) if (lum[j] >= medLum) vals.push(rgb[idx[j] * 3 + ch]);
    color[ch] = Uint8Array.from(vals).sort()[vals.length >> 1];
  }
  return { width, color };
}
