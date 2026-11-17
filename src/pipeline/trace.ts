// Final step: turn the flat-colour picture into vector shapes with VTracer
// (compiled to WebAssembly), then read the shapes out of the SVG it returns.

import { initVtracer, vectorize_rgba } from "../vendor/vtracer/vtracer_wasm.js";
import wasmUrl from "../vendor/vtracer/vtracer_wasm_bg.wasm?url";
import type { CleanupSettings, Shape } from "./types";

export async function trace(rgba: Uint8Array, W: number, H: number, s: CleanupSettings): Promise<Shape[]> {
  await initVtracer(wasmUrl);
  const svg = vectorize_rgba(rgba, W, H, {
    // Same fixed choices as vectorize.py: stacked shapes, smooth splines.
    hierarchical: "stacked",
    mode: "spline",
    colorPrecision: 8,
    layerDifference: 4,
    pathPrecision: 3,
    filterSpeckle: Math.max(0, Math.round(s.speckle)),
    // Sharpness 50 -> 60 degrees (vectorize.py's value). Higher sharpness =
    // smaller angle needed to count as a corner = more corners kept.
    cornerThreshold: Math.round(110 - s.cornerSharpness),
    // Smoothness 40 -> 4.0 (vectorize.py's value). Larger = longer segments.
    lengthThreshold: 2 + s.curveSmoothness / 20,
    spliceThreshold: 45,
  });
  return parseShapes(svg);
}

/** Pull every <path> out of VTracer's SVG text, in drawing order. */
export function parseShapes(svg: string): Shape[] {
  const shapes: Shape[] = [];
  const pathRe = /<path\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svg))) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m![1])?.[1];
    const d = attr("d"), fill = attr("fill");
    if (!d || !fill) continue;
    const transform = attr("transform");
    shapes.push(transform ? { d, fill: fill.toUpperCase(), transform } : { d, fill: fill.toUpperCase() });
  }
  return shapes;
}
