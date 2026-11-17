// Shared types for the clean-up pipeline (used by both the page and the worker).

/** Everything the "Clean up" panel controls. */
export interface CleanupSettings {
  removeBackground: boolean;
  /** How different neighbouring pixels may be and still count as background. */
  bgTolerance: number;
  /** Texture-removal strength, in image pixels (0 = off). */
  smooth: number;
  /** Number of colours to reduce to (2-16). */
  colors: number;
  /** Shades closer than this (Lab distance) are merged into one. */
  merge: number;
  /** Shapes smaller than about speckle x speckle pixels are dropped. */
  speckle: number;
  /** 0-100. Higher keeps more sharp corners. */
  cornerSharpness: number;
  /** 0-100. Higher gives longer, smoother curves with fewer points. */
  curveSmoothness: number;
  paletteSnap: boolean;
  /** Brand colours as "#RRGGBB", used when paletteSnap is on. */
  palette: string[];
  /** Replace the outer outline with a perfect shape: auto-detect, force one, or leave as traced. */
  outlineSnap: "auto" | "circle" | "rect" | "off";
  /** Detect the outer border band and redraw it as one solid band. */
  border: boolean;
  /** Extra border width in image pixels, added to the detected width (may be negative). */
  borderExtra: number;
  /** Border colour as "#RRGGBB", or null to take it from the image. */
  borderColor: string | null;
}

/** One traced shape. Shapes are stacked: later ones are drawn on top. */
export interface Shape {
  d: string;
  fill: string;
  transform?: string;
}

export interface TraceResult {
  /** Size of the vector drawing's coordinate system (the "working" size). */
  width: number;
  height: number;
  shapes: Shape[];
  /** Distinct fill colours, most used first. */
  colors: string[];
  /** How long the run took, in milliseconds. */
  ms: number;
  /** What the outer outline was recognised as, e.g. "circle" ("" if background removal is off). */
  outline: string;
  /** Width of the redrawn border band in drawing units (0 = none). */
  borderWidth: number;
}

export type WorkerRequest =
  | { type: "image"; bitmap: ImageBitmap }
  | { type: "run"; id: number; settings: CleanupSettings };

export type WorkerResponse =
  | { type: "progress"; id: number; stage: string; fraction: number }
  | { type: "done"; id: number; result: TraceResult }
  | { type: "error"; id: number; message: string };

/** Sizes the pipeline works at, derived from the opened image. */
export interface Sizes {
  /** "Base" size: the image itself, shrunk only if its long side is over 2048. */
  bw: number;
  bh: number;
  /** Enlargement from base to working size (the Python script's "scale"). */
  scale: number;
  /** Working size: about 2000 px wide, where labels are finalised and traced. */
  W: number;
  H: number;
}

const BASE_MAX = 2048;
const WORK_MAX = 2700;

export function planSizes(srcW: number, srcH: number): Sizes {
  const k = Math.min(1, BASE_MAX / Math.max(srcW, srcH));
  const bw = Math.max(1, Math.round(srcW * k));
  const bh = Math.max(1, Math.round(srcH * k));
  // Same rule as vectorize.py (integer enlargement to ~2000 px wide), but capped
  // so tall or very large images do not blow up memory in the browser.
  let scale = Math.max(1, Math.round(2000 / bw));
  scale = Math.max(1, Math.min(scale, WORK_MAX / Math.max(bw, bh)));
  return { bw, bh, scale, W: Math.round(bw * scale), H: Math.round(bh * scale) };
}

/** Sensible starting settings for an image, mirroring vectorize.py's defaults. */
export function defaultSettings(srcW: number, srcH: number, palette: string[]): CleanupSettings {
  const { bw, W } = planSizes(srcW, srcH);
  return {
    removeBackground: true,
    bgTolerance: 3,
    smooth: Math.round(Math.max(2, bw / 150) * 2) / 2,
    colors: 8,
    merge: 14,
    speckle: Math.round(W / 50),
    cornerSharpness: 50,
    curveSmoothness: 40,
    paletteSnap: false,
    palette,
    outlineSnap: "auto",
    border: true,
    borderExtra: 7,
    borderColor: null,
  };
}
