// Step 5 of the pipeline: cut the design out of its background.
//
// We "pour paint" in from the four corners. The paint spreads to a neighbour
// whenever the colour changes only slightly, so it flows across a plain
// background and its soft drop shadow, but stops at the design's hard edge.
// Whatever stays dry is the design: we keep the largest piece and fill holes.

import { bilateral, gaussianBlur } from "./filters";

/** Flood from the given start pixels through 4-connected neighbours that pass `ok`. */
function flood(w: number, h: number, starts: number[], visited: Uint8Array, ok: (from: number, to: number) => boolean) {
  const stack = new Int32Array(w * h);
  let top = 0;
  for (const s of starts) if (!visited[s]) { visited[s] = 1; stack[top++] = s; }
  while (top > 0) {
    const p = stack[--top];
    const x = p % w;
    if (x > 0 && !visited[p - 1] && ok(p, p - 1)) { visited[p - 1] = 1; stack[top++] = p - 1; }
    if (x < w - 1 && !visited[p + 1] && ok(p, p + 1)) { visited[p + 1] = 1; stack[top++] = p + 1; }
    if (p >= w && !visited[p - w] && ok(p, p - w)) { visited[p - w] = 1; stack[top++] = p - w; }
    if (p < w * (h - 1) && !visited[p + w] && ok(p, p + w)) { visited[p + w] = 1; stack[top++] = p + w; }
  }
}

/**
 * Design mask at base size as a soft 0..1 image (1 = design). `tolerance` is
 * the largest per-channel colour step the flood may cross.
 * Returns null when nothing sensible was found (e.g. a blank image).
 */
export function backgroundMaskSoft(rgb: Uint8Array, w: number, h: number, tolerance: number): Float32Array | null {
  const edge = bilateral(rgb, w, h, 2, 30, 4.5);
  const n = w * h;

  // 1. Flood the background in from the corners.
  const bg = new Uint8Array(n);
  flood(w, h, [0, w - 1, (h - 1) * w, n - 1], bg, (a, b) =>
    Math.abs(edge[a * 3] - edge[b * 3]) <= tolerance &&
    Math.abs(edge[a * 3 + 1] - edge[b * 3 + 1]) <= tolerance &&
    Math.abs(edge[a * 3 + 2] - edge[b * 3 + 2]) <= tolerance);

  // 2. Keep only the biggest connected object (8 directions count as touching).
  const comp = new Int32Array(n); // 0 = none yet
  const stack = new Int32Array(n);
  let bestId = 0, bestArea = 0, id = 0;
  for (let s = 0; s < n; s++) {
    if (bg[s] || comp[s]) continue;
    id++;
    let top = 0, area = 0;
    comp[s] = id; stack[top++] = s;
    while (top > 0) {
      const p = stack[--top]; area++;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (!bg[q] && !comp[q]) { comp[q] = id; stack[top++] = q; }
        }
    }
    if (area > bestArea) { bestArea = area; bestId = id; }
  }
  if (bestArea === 0 || bestArea === n) return null;

  // 3. Fill holes: anything not reachable from the image border is design.
  const outside = new Uint8Array(n);
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  flood(w, h, border.filter((p) => comp[p] !== bestId), outside, (_a, b) => comp[b] !== bestId);

  // 4. Soften, so the cut-out edge is smooth rather than pixel-stepped.
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = outside[i] ? 0 : 1;
  gaussianBlur(soft, w, h, 3);
  return soft;
}

/**
 * Enlarge a soft mask to working size and make it yes/no. The threshold is a
 * little above one half, which trims the faint halo around the design's edge
 * (vectorize.py does this by eroding the mask slightly).
 */
export function upsampleMask(soft: Float32Array, w: number, h: number, W: number, H: number, threshold = 0.566): Uint8Array {
  const out = new Uint8Array(W * H);
  const kx = w / W, ky = h / H;
  for (let Y = 0; Y < H; Y++) {
    const fy = Math.max(0, Math.min(h - 1, (Y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let X = 0; X < W; X++) {
      const fx = Math.max(0, Math.min(w - 1, (X + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const top = soft[y0 * w + x0] + (soft[y0 * w + x1] - soft[y0 * w + x0]) * wx;
      const bot = soft[y1 * w + x0] + (soft[y1 * w + x1] - soft[y1 * w + x0]) * wx;
      out[Y * W + X] = top + (bot - top) * wy > threshold ? 1 : 0;
    }
  }
  return out;
}
