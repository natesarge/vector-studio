// Step 3 of the pipeline: reduce the image to N flat colours with K-means in
// Lab colour space, then merge shades that are nearly identical.
//
// Speed trick: instead of clustering millions of pixels, we first bucket them
// into a coarse colour histogram (64 levels per channel) and cluster the
// occupied buckets, each weighted by how many pixels fell into it.

import { rgbToLab, type RGB } from "./color";
import type { Tick } from "./filters";

const BINS = 1 << 18; // 64 x 64 x 64
/** Histogram bucket of an RGB colour. */
export const binOf = (r: number, g: number, b: number) => ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);

/** OpenCV's 8-bit Lab stretches L from 0..100 to 0..255; vectorize.py clusters in that space. */
const L_STRETCH = 2.55;

export interface Quantized {
  /** Cluster number for every histogram bucket (255 = bucket unused). */
  binLabel: Uint8Array;
  /** Cluster centres as real Lab colours. */
  centers: RGB[];
  /** Number of pixels in each cluster. */
  counts: number[];
}

/** Small seeded random generator so results are the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function quantize(rgb: Uint8Array, n: number, k: number, tick: Tick): Promise<Quantized> {
  // 1. Histogram: pixel count and colour sum per bucket.
  const count = new Uint32Array(BINS);
  const sum = new Float64Array(BINS * 3);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const bin = binOf(r, g, b);
    count[bin]++; sum[bin * 3] += r; sum[bin * 3 + 1] += g; sum[bin * 3 + 2] += b;
  }
  const bins: number[] = [];
  for (let b = 0; b < BINS; b++) if (count[b]) bins.push(b);
  const m = bins.length;
  k = Math.max(1, Math.min(k, m));

  // 2. One weighted point per occupied bucket, in (stretched) Lab.
  const pts = new Float32Array(m * 3);
  const wts = new Float64Array(m);
  let total = 0;
  for (let j = 0; j < m; j++) {
    const b = bins[j], c = count[b];
    const lab = rgbToLab(sum[b * 3] / c, sum[b * 3 + 1] / c, sum[b * 3 + 2] / c);
    pts[j * 3] = lab[0] * L_STRETCH; pts[j * 3 + 1] = lab[1]; pts[j * 3 + 2] = lab[2];
    wts[j] = c; total += c;
  }
  await tick(0.2);

  // 3. K-means, best of 4 starts (like sklearn's n_init=4).
  const rand = rng(12345);
  const assign = new Uint8Array(m), bestAssign = new Uint8Array(m);
  let bestCen = new Float64Array(k * 3), bestCost = Infinity;
  const dist2 = new Float64Array(m);

  for (let run = 0; run < 4; run++) {
    const cen = new Float64Array(k * 3);
    // k-means++ seeding: spread the starting centres out.
    const pick = (weights: Float64Array, sumW: number) => {
      let t = rand() * sumW;
      for (let j = 0; j < m; j++) { t -= weights[j]; if (t <= 0) return j; }
      return m - 1;
    };
    let j0 = pick(wts, total);
    cen.set(pts.subarray(j0 * 3, j0 * 3 + 3), 0);
    dist2.fill(Infinity);
    const wd = new Float64Array(m);
    for (let c = 1; c < k; c++) {
      let sumWd = 0;
      const o = (c - 1) * 3;
      for (let j = 0; j < m; j++) {
        const d0 = pts[j * 3] - cen[o], d1 = pts[j * 3 + 1] - cen[o + 1], d2 = pts[j * 3 + 2] - cen[o + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < dist2[j]) dist2[j] = d;
        wd[j] = dist2[j] * wts[j]; sumWd += wd[j];
      }
      j0 = sumWd > 0 ? pick(wd, sumWd) : Math.floor(rand() * m);
      cen.set(pts.subarray(j0 * 3, j0 * 3 + 3), c * 3);
    }

    // Lloyd iterations: assign points to nearest centre, move centres, repeat.
    let cost = 0;
    for (let it = 0; it < 80; it++) {
      const acc = new Float64Array(k * 4);
      cost = 0;
      for (let j = 0; j < m; j++) {
        const p0 = pts[j * 3], p1 = pts[j * 3 + 1], p2 = pts[j * 3 + 2];
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d0 = p0 - cen[c * 3], d1 = p1 - cen[c * 3 + 1], d2 = p2 - cen[c * 3 + 2];
          const d = d0 * d0 + d1 * d1 + d2 * d2;
          if (d < bd) { bd = d; best = c; }
        }
        assign[j] = best; cost += bd * wts[j];
        const w = wts[j];
        acc[best * 4] += p0 * w; acc[best * 4 + 1] += p1 * w; acc[best * 4 + 2] += p2 * w; acc[best * 4 + 3] += w;
      }
      let shift = 0;
      for (let c = 0; c < k; c++) {
        const w = acc[c * 4 + 3];
        if (w === 0) continue; // empty cluster keeps its centre
        for (let ch = 0; ch < 3; ch++) {
          const v = acc[c * 4 + ch] / w;
          shift += (v - cen[c * 3 + ch]) ** 2;
          cen[c * 3 + ch] = v;
        }
      }
      if (shift < 1e-3) break;
    }
    if (cost < bestCost) { bestCost = cost; bestCen = cen; bestAssign.set(assign); }
    await tick(0.2 + 0.2 * (run + 1));
  }

  const binLabel = new Uint8Array(BINS).fill(255);
  const counts = new Array<number>(k).fill(0);
  for (let j = 0; j < m; j++) { binLabel[bins[j]] = bestAssign[j]; counts[bestAssign[j]] += wts[j]; }
  const centers: RGB[] = [];
  for (let c = 0; c < k; c++)
    centers.push([bestCen[c * 3] / L_STRETCH, bestCen[c * 3 + 1], bestCen[c * 3 + 2]]);
  return { binLabel, centers, counts };
}

/**
 * Merge near-identical shades: each colour (largest areas first) is folded
 * into a bigger colour that is closer than `threshold` in Lab. Returns, for
 * each cluster, the cluster it ends up as.
 */
export function mergeShades(q: Quantized, threshold: number): number[] {
  const k = q.centers.length;
  const order = q.counts.map((_, i) => i).sort((a, b) => q.counts[b] - q.counts[a]);
  const remap = order.map((_, i) => i).sort((a, b) => a - b);
  for (const i of order) {
    for (const j of order) {
      if (j === i) break; // only look at colours bigger than i
      const d = Math.hypot(
        q.centers[i][0] - q.centers[j][0], q.centers[i][1] - q.centers[j][1], q.centers[i][2] - q.centers[j][2]);
      if (remap[j] === j && d < threshold) { remap[i] = j; break; }
    }
  }
  return remap.slice(0, k);
}
