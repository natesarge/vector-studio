// Step 4 of the pipeline: smooth the boundaries between colour regions.
//
// For every colour we make a soft "how much of this colour is near here" map
// (a blurred yes/no image). Each output pixel then takes the colour with the
// highest vote. This rounds off jagged edges and removes thin fringes.
//
// The votes are computed at the image's own size and read back at the larger
// working size with interpolation, which gives smooth sub-pixel boundaries
// without ever holding several full-size float images in memory.

import { gaussianBlur, type Tick } from "./filters";

/**
 * @param labels  colour number per base pixel (bw x bh)
 * @param k       number of colour numbers in use (labels are 0..k-1)
 * @param sigma   blur size in base pixels
 * @returns       colour number per working pixel (W x H)
 */
export async function voteLabels(
  labels: Uint8Array, bw: number, bh: number, k: number, sigma: number,
  W: number, H: number, tick: Tick,
): Promise<Uint8Array> {
  const out = new Uint8Array(W * H);
  const best = new Float32Array(W * H);
  const sx = bw / W, sy = bh / H;
  const pad = Math.ceil(sigma * 3) + 2;

  // Bounding box of every colour, so small regions cost little.
  const box = new Int32Array(k * 4);
  for (let i = 0; i < k; i++) { box[i * 4] = bw; box[i * 4 + 1] = bh; box[i * 4 + 2] = -1; box[i * 4 + 3] = -1; }
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const o = labels[y * bw + x] * 4;
      if (x < box[o]) box[o] = x;
      if (y < box[o + 1]) box[o + 1] = y;
      if (x > box[o + 2]) box[o + 2] = x;
      if (y > box[o + 3]) box[o + 3] = y;
    }

  for (let i = 0; i < k; i++) {
    if (box[i * 4 + 2] < 0) continue; // colour not used
    const x0 = Math.max(0, box[i * 4] - pad), y0 = Math.max(0, box[i * 4 + 1] - pad);
    const x1 = Math.min(bw - 1, box[i * 4 + 2] + pad), y1 = Math.min(bh - 1, box[i * 4 + 3] + pad);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;

    // Yes/no image for this colour, then blur it.
    const vote = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = (y + y0) * bw + x0;
      for (let x = 0; x < w; x++) if (labels[row + x] === i) vote[y * w + x] = 1;
    }
    gaussianBlur(vote, w, h, sigma);

    // Read the blurred map at working resolution; keep the winner per pixel.
    const X0 = Math.max(0, Math.floor(x0 / sx)), X1 = Math.min(W - 1, Math.ceil((x1 + 1) / sx));
    const Y0 = Math.max(0, Math.floor(y0 / sy)), Y1 = Math.min(H - 1, Math.ceil((y1 + 1) / sy));
    const colIdx = new Int32Array(X1 - X0 + 1), colW = new Float32Array(X1 - X0 + 1);
    for (let X = X0; X <= X1; X++) {
      const fx = Math.max(0, Math.min(w - 1, (X + 0.5) * sx - 0.5 - x0));
      const xi = Math.min(w - 2 < 0 ? 0 : w - 2, Math.floor(fx));
      colIdx[X - X0] = xi; colW[X - X0] = fx - xi;
    }
    const row = new Float32Array(w + 1);
    for (let Y = Y0; Y <= Y1; Y++) {
      const fy = Math.max(0, Math.min(h - 1, (Y + 0.5) * sy - 0.5 - y0));
      const yi = Math.min(h - 2 < 0 ? 0 : h - 2, Math.floor(fy)), wy = fy - yi;
      const a = yi * w, b = Math.min(h - 1, yi + 1) * w;
      for (let x = 0; x < w; x++) row[x] = vote[a + x] + (vote[b + x] - vote[a + x]) * wy;
      row[w] = row[w - 1];
      const o = Y * W + X0;
      for (let j = 0; j <= X1 - X0; j++) {
        const xi = colIdx[j];
        const v = row[xi] + (row[xi + 1] - row[xi]) * colW[j];
        if (v > best[o + j]) { best[o + j] = v; out[o + j] = i; }
      }
    }
    await tick((i + 1) / k);
  }
  return out;
}
