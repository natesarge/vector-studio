// Colour helpers: hex <-> RGB and sRGB -> CIE Lab (D65), matching OpenCV.

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.trim().replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const p = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return ("#" + p(r) + p(g) + p(b)).toUpperCase();
}

/** True for "#RRGGBB". */
export const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s.trim());

// sRGB byte -> linear light, precomputed.
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (0-255) -> real CIE Lab: L 0..100, a and b roughly -128..127. */
export function rgbToLab(r: number, g: number, b: number): RGB {
  const R = LINEAR[r | 0], G = LINEAR[g | 0], B = LINEAR[b | 0];
  const fx = labF((0.412453 * R + 0.35758 * G + 0.180423 * B) / 0.950456);
  const fy = labF(0.212671 * R + 0.71516 * G + 0.072169 * B);
  const fz = labF((0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Straight-line distance between two Lab colours (a simple "how different"). */
export function labDist(p: RGB, q: RGB): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** The palette colour closest (in Lab) to the given RGB colour. */
export function nearestPaletteColor(rgb: RGB, palette: RGB[]): RGB {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let best = palette[0], bestD = Infinity;
  for (const p of palette) {
    const d = labDist(lab, rgbToLab(p[0], p[1], p[2]));
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
