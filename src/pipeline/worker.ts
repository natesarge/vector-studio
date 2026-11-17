// The Web Worker: runs the whole clean-up pipeline off the main thread so the
// page stays responsive. It is a TypeScript port of reference/vectorize.py.
//
// Results of each step are remembered, so moving a slider only redoes the
// steps that depend on it. A newer request cancels the one in progress.

/// <reference lib="webworker" />
import { hexToRgb, nearestPaletteColor, rgbToHex, type RGB } from "./color";
import { backgroundMaskSoft } from "./background";
import { findBorder, fitName, renderFit, snapOutline } from "./outline";
import type { Tick } from "./filters";
import { binOf, mergeShades, quantize, type Quantized } from "./kmeans";
import { voteLabels } from "./labels";
import { removeTexture } from "./meanshift";
import { trace } from "./trace";
import { planSizes, type CleanupSettings, type Sizes, type TraceResult, type WorkerRequest, type WorkerResponse } from "./types";

const post = (m: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(m);

// ------------------------------------------------------------ state
interface Loaded { id: number; rgb: Uint8Array; sizes: Sizes }
let image: Loaded | null = null;
let imageCounter = 0;
let latest: { id: number; settings: CleanupSettings } | null = null;
let finishedId = -1;
let busy = false;

/** One remembered result per step, valid while its key is unchanged. */
const cache = new Map<string, { key: string; value: unknown }>();
async function step<T>(name: string, key: string, compute: () => Promise<T> | T): Promise<T> {
  const hit = cache.get(name);
  if (hit && hit.key === key) return hit.value as T;
  const value = await compute();
  cache.set(name, { key, value });
  return value;
}

const CANCELLED = Symbol("cancelled");
/** Level of the soft background mask that separates design from background (see background.ts). */
const MASK_LEVEL = 0.566;

// ------------------------------------------------------------ messages
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === "image") {
    loadImage(m.bitmap);
  } else {
    latest = { id: m.id, settings: m.settings };
    if (!busy) void loop();
  }
};

/** Draw the picture at base size on white (transparent areas become white). */
function loadImage(bitmap: ImageBitmap) {
  const sizes = planSizes(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(sizes.bw, sizes.bh);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, sizes.bw, sizes.bh);
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, sizes.bw, sizes.bh);
  bitmap.close();
  const rgba = g.getImageData(0, 0, sizes.bw, sizes.bh).data;
  const rgb = new Uint8Array(sizes.bw * sizes.bh * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
  }
  image = { id: ++imageCounter, rgb, sizes };
  cache.clear();
}

async function loop() {
  busy = true;
  while (latest && latest.id !== finishedId) {
    const req = latest;
    try {
      const result = await run(req.id, req.settings);
      post({ type: "done", id: req.id, result });
      finishedId = req.id;
    } catch (err) {
      if (err === CANCELLED) continue; // a newer request arrived: start over with it
      post({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
      finishedId = req.id;
    }
  }
  busy = false;
}

// ------------------------------------------------------------ the pipeline
async function run(id: number, s: CleanupSettings): Promise<TraceResult> {
  if (!image) throw new Error("No image loaded.");
  const im = image;
  const { rgb, sizes } = im;
  const { bw, bh, scale, W, H } = sizes;
  const n = bw * bh;
  const t0 = performance.now();

  // Progress reporting + cancellation. Each stage owns a slice of the bar.
  let lastYield = performance.now();
  let stageName = "", stageFrom = 0, stageTo = 0;
  // How long each stage took, for the console (handy when tuning speed).
  const timings: string[] = [];
  let stageStart = t0;
  const stage = (name: string, from: number, to: number) => {
    const now = performance.now();
    if (stageName) timings.push(`${stageName} ${Math.round(now - stageStart)}ms`);
    stageStart = now;
    stageName = name; stageFrom = from; stageTo = to;
    post({ type: "progress", id, stage: name, fraction: from });
  };
  const tick: Tick = async (f) => {
    const now = performance.now();
    if (now - lastYield < 60) return;
    post({ type: "progress", id, stage: stageName, fraction: stageFrom + (stageTo - stageFrom) * f });
    await new Promise((r) => setTimeout(r, 0)); // let new messages in
    lastYield = performance.now();
    if (latest!.id !== id || image !== im) throw CANCELLED;
  };
  const pause = () => { lastYield = 0; return tick(1); };

  // 1-2. Remove texture (mean shift + bilateral).
  stage("Smoothing texture", 0, 0.4);
  const smoothKey = `${im.id}|${s.smooth}`;
  const smoothed = await step("smooth", smoothKey, () =>
    // vectorize.py searches 6 x smooth working pixels = 6 x smooth / scale image pixels.
    removeTexture(rgb, bw, bh, s.smooth > 0 ? Math.max(1, Math.round((s.smooth * 6) / scale)) : 0, 28, tick));

  // 3. Reduce to N colours, then merge near-identical shades.
  stage("Reducing colors", 0.4, 0.5);
  const quantKey = `${smoothKey}|${s.colors}`;
  const q = await step<Quantized>("quant", quantKey, () => quantize(smoothed, n, s.colors, tick));
  const remap = mergeShades(q, s.merge);
  const k = q.centers.length;

  // 4. Smooth the boundaries between colours (and enlarge to working size).
  stage("Smoothing edges", 0.5, 0.7);
  const labelsKey = `${quantKey}|${remap.join(",")}`;
  const labels = await step("labels", labelsKey, () => {
    const base = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      base[i] = remap[q.binLabel[binOf(smoothed[i * 3], smoothed[i * 3 + 1], smoothed[i * 3 + 2])]];
    return voteLabels(base, bw, bh, k, s.smooth / 2, W, H, tick);
  });

  // 5. Cut out the design (remove background + shadow).
  stage("Removing background", 0.7, 0.74);
  await pause();
  const maskKey = `${im.id}|${s.removeBackground}|${s.bgTolerance}`;
  const soft = await step("soft", maskKey, () =>
    // Tolerance is per working pixel in vectorize.py; base pixels are `scale` times bigger.
    s.removeBackground ? backgroundMaskSoft(rgb, bw, bh, s.bgTolerance * scale) : null);

  // 6. Snap the outer outline to a perfect circle / rounded rectangle if it fits.
  stage("Shaping the outline", 0.74, 0.77);
  const fitKey = `${maskKey}|${s.outlineSnap}`;
  const fit = soft && (await step("fit", fitKey, () => snapOutline(soft, MASK_LEVEL, bw, bh, s.outlineSnap)));
  const mask = fit && (await step("maskW", fitKey, () => renderFit(fit, sizes)));

  // 7. Find the outer border band and redraw it as one solid band.
  let finalLabels = labels, kOut = k, borderLabel = -1, borderWidth = 0;
  let borderRgb: RGB | null = null;
  if (soft && fit && mask && s.border) {
    stage("Finding the border", 0.77, 0.8);
    await pause();
    const found = await step("border", `${labelsKey}|${maskKey}`, () => {
      const baseLabels = new Uint8Array(n), raw = new Uint8Array(n);
      for (let y = 0; y < bh; y++) {
        const Y = Math.min(H - 1, Math.floor((y + 0.5) * scale));
        for (let x = 0; x < bw; x++) {
          const i = y * bw + x;
          baseLabels[i] = labels[Y * W + Math.min(W - 1, Math.floor((x + 0.5) * scale))];
          raw[i] = soft[i] > MASK_LEVEL ? 1 : 0;
        }
      }
      return findBorder(baseLabels, k, raw, rgb, bw, bh);
    });
    if (found) {
      borderWidth = Math.max(1, found.width + s.borderExtra);
      const inner = await step("inner", `${fitKey}|${labelsKey}|${borderWidth}`, () => renderFit(fit, sizes, borderWidth));
      borderLabel = k;
      kOut = k + 1;
      finalLabels = new Uint8Array(labels);
      // The band, and everything outside the design (so no fringe shows at the edge).
      for (let i = 0; i < W * H; i++) if (!mask[i] || !inner[i]) finalLabels[i] = borderLabel;
      borderRgb = s.borderColor ? hexToRgb(s.borderColor) : found.color;
    }
  }

  // 8. Final colours: each region's real median colour, optionally snapped to a palette.
  stage("Picking colors", 0.8, 0.82);
  const hist = new Uint32Array(kOut * 3 * 256);
  const total = new Uint32Array(kOut);
  for (let y = 0; y < bh; y++) {
    const Y = Math.min(H - 1, Math.floor((y + 0.5) * scale));
    for (let x = 0; x < bw; x++) {
      const lab = finalLabels[Y * W + Math.min(W - 1, Math.floor((x + 0.5) * scale))];
      const p = (y * bw + x) * 3, o = lab * 768;
      hist[o + rgb[p]]++; hist[o + 256 + rgb[p + 1]]++; hist[o + 512 + rgb[p + 2]]++;
      total[lab]++;
    }
  }
  const brand = s.paletteSnap && s.palette.length ? s.palette.map(hexToRgb) : null;
  const pal: RGB[] = [];
  for (let i = 0; i < kOut; i++) {
    if (i === borderLabel && borderRgb) {
      // A colour the user typed is used exactly; a detected one may be snapped.
      pal.push(brand && !s.borderColor ? nearestPaletteColor(borderRgb, brand) : borderRgb);
      total[i] = Math.max(1, total[i]);
      continue;
    }
    const med: RGB = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0, v = 0;
      while (v < 255 && (acc += hist[i * 768 + ch * 256 + v]) * 2 < total[i]) v++;
      med[ch] = v;
    }
    pal.push(brand ? nearestPaletteColor(med, brand) : med);
  }

  // Flat-colour picture with transparency outside the design.
  const flat = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const c = pal[finalLabels[i]];
    flat[i * 4] = c[0]; flat[i * 4 + 1] = c[1]; flat[i * 4 + 2] = c[2];
    flat[i * 4 + 3] = !mask || mask[i] ? 255 : 0;
  }

  // 9. Trace to vector shapes.
  stage("Tracing shapes", 0.82, 1);
  await pause();
  const shapes = await trace(flat, W, H, s);

  // VTracer sometimes reports a shape's colour a few shades off (it averages
  // internally). Put every shape back on the exact colour we chose above.
  const exact = new Map<string, string>();
  for (const sh of shapes) {
    let fixed = exact.get(sh.fill);
    if (!fixed) {
      const c = hexToRgb(sh.fill);
      let bestD = Infinity, bestC = c;
      for (let i = 0; i < kOut; i++) {
        if (!total[i]) continue;
        const d = Math.hypot(c[0] - pal[i][0], c[1] - pal[i][1], c[2] - pal[i][2]);
        if (d < bestD) { bestD = d; bestC = pal[i]; }
      }
      fixed = rgbToHex(bestC[0], bestC[1], bestC[2]);
      exact.set(sh.fill, fixed);
    }
    sh.fill = fixed;
  }

  const use = new Map<string, number>();
  for (const sh of shapes) use.set(sh.fill, (use.get(sh.fill) ?? 0) + 1);
  const colors = [...use.keys()].sort((a, b) => use.get(b)! - use.get(a)!);
  stage("Done", 1, 1);
  console.debug("[pipeline] " + timings.join(" · "));
  return {
    width: W, height: H, shapes, colors, ms: Math.round(performance.now() - t0),
    outline: fit ? fitName(fit) : "", borderWidth: Math.round(borderWidth * scale),
  };
}
