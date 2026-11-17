// Step 2 of the pipeline: edge-preserving smoothing that removes texture
// (stitching, fabric, noise). A port of OpenCV's pyrMeanShiftFiltering.
//
// Mean shift, for one pixel: look at nearby pixels of a similar colour, move
// to their average position and colour, repeat a few times. Flat areas become
// truly flat while sharp edges stay sharp.

import { bilateral, downsample2, upsampleRgb, type Tick } from "./filters";

const MAX_ITER = 5;
/** How many samples per side we take from the search window (speed/quality). */
const SAMPLES = 13;

/**
 * One mean-shift pass. `mask` (optional) limits which pixels are processed;
 * the others are left as they already are in `dst`.
 */
async function meanShiftPass(
  src: Uint8Array, w: number, h: number, radius: number, colorRadius: number,
  mask: Uint8Array | null, dst: Uint8Array, tick: Tick, f0: number, f1: number,
) {
  const cr2 = colorRadius * colorRadius;
  // The window can be huge (e.g. 51 x 51), so sample every `step`-th pixel.
  const step = Math.max(1, Math.ceil((2 * radius + 1) / SAMPLES));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      let cx = x, cy = y;
      let c0 = src[i * 3], c1 = src[i * 3 + 1], c2 = src[i * 3 + 2];
      for (let it = 0; it < MAX_ITER; it++) {
        const y0 = Math.max(0, cy - radius), y1 = Math.min(h - 1, cy + radius);
        const x0 = Math.max(0, cx - radius), x1 = Math.min(w - 1, cx + radius);
        let n = 0, sx = 0, sy = 0, s0 = 0, s1 = 0, s2 = 0;
        for (let yy = y0; yy <= y1; yy += step) {
          let p = (yy * w + x0) * 3;
          for (let xx = x0; xx <= x1; xx += step, p += 3 * step) {
            const d0 = src[p] - c0, d1 = src[p + 1] - c1, d2 = src[p + 2] - c2;
            if (d0 * d0 + d1 * d1 + d2 * d2 <= cr2) {
              n++; sx += xx; sy += yy; s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2];
            }
          }
        }
        if (n === 0) break;
        const nx = Math.round(sx / n), ny = Math.round(sy / n);
        const n0 = Math.round(s0 / n), n1 = Math.round(s1 / n), n2 = Math.round(s2 / n);
        const moved = Math.abs(nx - cx) + Math.abs(ny - cy) +
          Math.abs(n0 - c0) + Math.abs(n1 - c1) + Math.abs(n2 - c2);
        const stop = (nx === cx && ny === cy) || moved <= 1;
        cx = nx; cy = ny; c0 = n0; c1 = n1; c2 = n2;
        if (stop) break;
      }
      dst[i * 3] = c0; dst[i * 3 + 1] = c1; dst[i * 3 + 2] = c2;
    }
    if ((y & 7) === 0) await tick(f0 + ((f1 - f0) * y) / h);
  }
}

/**
 * Texture removal. `radius` is how far (in pixels) similar colours are pulled
 * together; `colorRadius` is how similar they must be (28 in vectorize.py).
 *
 * Like OpenCV, this works coarse-to-fine: first at half size (fast), then only
 * the pixels near edges are redone at full size so edges stay crisp.
 */
export async function removeTexture(
  rgb: Uint8Array, w: number, h: number, radius: number, colorRadius: number, tick: Tick,
): Promise<Uint8Array> {
  if (radius < 1) return bilateral(rgb, w, h, 2, 40, 4.5);

  // Coarse level.
  const half = downsample2(rgb, w, h);
  const halfOut = new Uint8Array(half.data.length);
  await meanShiftPass(half.data, half.w, half.h, Math.max(1, Math.round(radius / 2)), colorRadius,
    null, halfOut, tick, 0, 0.55);

  // Fine level: start from the enlarged coarse result...
  const out = upsampleRgb(halfOut, half.w, half.h, w, h);
  // ...and redo pixels where it disagrees with the real image (edges, details).
  const differs = new Uint8Array(w * h);
  const limit = Math.max(colorRadius * colorRadius, 16);
  for (let i = 0; i < w * h; i++) {
    const d0 = out[i * 3] - rgb[i * 3], d1 = out[i * 3 + 1] - rgb[i * 3 + 1], d2 = out[i * 3 + 2] - rgb[i * 3 + 2];
    if (d0 * d0 + d1 * d1 + d2 * d2 > limit) differs[i] = 1;
  }
  const mask = new Uint8Array(w * h); // `differs`, grown by one pixel
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!differs[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) mask[yy * w + xx] = 1;
        }
    }
  await meanShiftPass(rgb, w, h, radius, colorRadius, mask, out, tick, 0.55, 0.9);

  // A light bilateral pass tidies what is left (vectorize.py does the same).
  const result = bilateral(out, w, h, 2, 40, 4.5);
  await tick(1);
  return result;
}
