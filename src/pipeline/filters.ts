// Small image-processing building blocks, written by hand so we do not need
// OpenCV. Colour images are Uint8Array with 3 bytes per pixel (R, G, B).

/** Called now and then from long loops: reports progress and lets a newer job cancel this one. */
export type Tick = (fraction: number) => Promise<void>;

/** Halve an RGB image by averaging each 2x2 block. */
export function downsample2(src: Uint8Array, w: number, h: number) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
  const dst = new Uint8Array(w2 * h2 * 3);
  for (let y = 0; y < h2; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < w2; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const a = (y0 * w + x0) * 3, b = (y0 * w + x1) * 3, c = (y1 * w + x0) * 3, d = (y1 * w + x1) * 3;
      const o = (y * w2 + x) * 3;
      dst[o] = (src[a] + src[b] + src[c] + src[d] + 2) >> 2;
      dst[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1] + 2) >> 2;
      dst[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2] + 2) >> 2;
    }
  }
  return { data: dst, w: w2, h: h2 };
}

/** Enlarge an RGB image to (w, h) with bilinear interpolation. */
export function upsampleRgb(src: Uint8Array, sw: number, sh: number, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h * 3);
  const kx = sw / w, ky = sh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const a = (y0 * sw + x0) * 3, b = (y0 * sw + x1) * 3, c = (y1 * sw + x0) * 3, d = (y1 * sw + x1) * 3;
      const o = (y * w + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[a + ch] + (src[b + ch] - src[a + ch]) * wx;
        const bot = src[c + ch] + (src[d + ch] - src[c + ch]) * wx;
        dst[o + ch] = top + (bot - top) * wy + 0.5;
      }
    }
  }
  return dst;
}

/**
 * Bilateral filter: blurs noise but not edges. Each pixel becomes a weighted
 * average of its neighbours, where neighbours of a very different colour count
 * for almost nothing.
 */
export function bilateral(
  src: Uint8Array, w: number, h: number, radius: number, sigmaColor: number, sigmaSpace: number,
): Uint8Array {
  const dst = new Uint8Array(src.length);
  // Weight by colour difference (sum of the three channel differences, 0..765).
  const cw = new Float32Array(766);
  for (let i = 0; i < 766; i++) cw[i] = Math.exp((-i * i) / (2 * sigmaColor * sigmaColor));
  const size = radius * 2 + 1;
  const sw = new Float32Array(size * size);
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      sw[(dy + radius) * size + dx + radius] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      const r0 = src[p], g0 = src[p + 1], b0 = src[p + 2];
      let sr = 0, sg = 0, sb = 0, sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = (yy * w + xx) * 3;
          const r = src[q], g = src[q + 1], b = src[q + 2];
          const wgt = sw[(dy + radius) * size + dx + radius] *
            cw[Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)];
          sr += r * wgt; sg += g * wgt; sb += b * wgt; sum += wgt;
        }
      }
      dst[p] = sr / sum + 0.5; dst[p + 1] = sg / sum + 0.5; dst[p + 2] = sb / sum + 0.5;
    }
  }
  return dst;
}

/** Three box-blur widths whose combination closely imitates a Gaussian blur. */
function boxRadii(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  const m = Math.round((12 * sigma * sigma - n * lo * lo - 4 * n * lo - 3 * n) / (-4 * lo - 4));
  return [0, 1, 2].map((i) => ((i < m ? lo : lo + 2) - 1) / 2);
}

/** Box blur along one row or column (given as start + stride), edges repeated. */
function boxLine(
  src: Float32Array, dst: Float32Array, start: number, stride: number, n: number, r: number,
  line: Float32Array,
) {
  if (r <= 0) {
    for (let i = 0; i < n; i++) dst[start + i * stride] = src[start + i * stride];
    return;
  }
  for (let i = 0; i < n; i++) line[i] = src[start + i * stride];
  const first = line[0], last = line[n - 1], inv = 1 / (2 * r + 1);
  const at = (i: number) => (i < 0 ? first : i >= n ? last : line[i]);
  let acc = 0;
  for (let i = -r; i <= r; i++) acc += at(i);
  for (let i = 0; i < n; i++) {
    dst[start + i * stride] = acc * inv;
    acc += at(i + r + 1) - at(i - r);
  }
}

/**
 * Gaussian blur of a one-channel float image, in place. Uses three box blurs,
 * which is far faster than a true Gaussian and visually the same.
 */
export function gaussianBlur(buf: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.3) return;
  const tmp = new Float32Array(buf.length);
  const line = new Float32Array(Math.max(w, h));
  for (const r of boxRadii(sigma)) {
    for (let y = 0; y < h; y++) boxLine(buf, tmp, y * w, 1, w, r, line);
    for (let x = 0; x < w; x++) boxLine(tmp, buf, x, w, h, r, line);
  }
}
