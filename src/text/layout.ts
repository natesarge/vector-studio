// Text layout: turns an editable text object into real vector outlines.
//
// Every letter is placed one at a time: along a straight line, a wave, or a
// circle, then the whole block is slanted, sloped, rotated and moved into
// place. The result is plain SVG path data, so text looks identical on screen
// and in every export, with no font needed by whoever opens the file.

import type { PathCommand } from "opentype.js";
import type { Box } from "../editor/geom";
import type { FontEntry } from "./fonts";

export interface TextObj {
  id: number;
  text: string;
  fontId: string;
  fill: string;
  /** Centre of the text block (the middle of the capital-letter height). */
  x: number;
  y: number;
  /** Font size in drawing units. Ignored while fitWidth is set. */
  size: number;
  /** When set, the size is chosen so the widest line is exactly this wide. */
  fitWidth: number | null;
  /** Extra space between letters, as a fraction of the capital height. */
  spacing: number;
  /** Distance between lines, as a multiple of the font size. */
  lineHeight: number;
  /** Degrees. rotation turns everything; slant leans letters; slope tilts the baseline. */
  rotation: number;
  slant: number;
  slope: number;
  curve: "none" | "bend" | "circle";
  /** -100..100: how strongly to bend (100 = a full circle). Positive arches up. */
  bend: number;
  /** For curve "circle": radius of the circle the text sits on. */
  radius: number;
  /** For curve "circle": text hangs along the bottom of the circle instead of the top. */
  curveDown: boolean;
  /** Wave height as a percentage of the font size (0 = off), and its length in font sizes. */
  wave: number;
  waveLength: number;
  /** Per-letter size variation. */
  sizeMode: "none" | "first" | "ends" | "middle" | "edges";
  sizeAmount: number;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowX: number;
  shadowY: number;
  /** 3D depth in drawing units (0 = off) and its direction in degrees. */
  extrude: number;
  extrudeAngle: number;
}

export const defaultText = (id: number, fontId: string, x: number, y: number, size: number): TextObj => ({
  id, text: "TEXT", fontId, fill: "#2D2520", x, y, size, fitWidth: null,
  spacing: 0, lineHeight: 1.1, rotation: 0, slant: 0, slope: 0,
  curve: "none", bend: 30, radius: size * 4, curveDown: false,
  wave: 0, waveLength: 4, sizeMode: "none", sizeAmount: 30,
  strokeColor: "#EFD8B1", strokeWidth: 0,
  shadow: false, shadowColor: "#000000", shadowX: size * 0.06, shadowY: size * 0.06,
  extrude: 0, extrudeAngle: 45,
});

export interface TextLayout {
  /** Outline of all letters, in drawing coordinates. */
  d: string;
  box: Box;
  /** The font size actually used (differs from obj.size while auto-fitting). */
  size: number;
}

// 2x3 affine matrices as [a, b, c, d, e, f] (same order as SVG's matrix()).
type M = [number, number, number, number, number, number];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const rot = (rad: number): M => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
const rad = (deg: number) => (deg * Math.PI) / 180;
const f2 = (v: number) => String(Math.round(v * 100) / 100);

/** Size multiplier for letter i of n. */
function letterScale(t: TextObj, i: number, n: number): number {
  const a = t.sizeAmount / 100;
  if (t.sizeMode === "none" || n < 2) return 1;
  if (t.sizeMode === "first") return i === 0 ? 1 + a : 1;
  if (t.sizeMode === "ends") return i === 0 || i === n - 1 ? 1 + a : 1;
  const hump = Math.sin((Math.PI * i) / (n - 1)); // 0 at the ends, 1 in the middle
  return t.sizeMode === "middle" ? 1 + a * hump : 1 + a * (1 - hump);
}

export function layoutText(t: TextObj, entry: FontEntry): TextLayout {
  const font = entry.font;
  const capF = entry.capHeight;
  const track = t.spacing * capF; // font units

  // 1. Measure every line in font units.
  const lines = t.text.split("\n").map((line) => {
    // One glyph per character. (opentype.js can also apply ligatures and other
    // substitutions, but that code fails on some fonts and logos do not need it.)
    const glyphs = Array.from(line, (ch) => font.charToGlyph(ch));
    const n = glyphs.length;
    const items: { cmds: PathCommand[]; pos: number; adv: number; k: number }[] = [];
    let pen = 0, width = 0;
    glyphs.forEach((g, i) => {
      const k = letterScale(t, i, n);
      const bb = g.path.commands.length ? g.getBoundingBox() : null;
      if (i === 0 && bb) pen = -bb.x1 * k; // first letter's ink starts at 0
      const adv = (g.advanceWidth ?? 0) * k;
      items.push({ cmds: g.path.commands, pos: pen, adv, k });
      width = pen + (bb ? bb.x2 * k : adv);
      let kern = 0;
      try {
        if (i < n - 1) kern = font.getKerningValue(g, glyphs[i + 1]) * k;
      } catch {
        // some fonts have kerning tables opentype.js cannot read: go without
      }
      pen += adv + kern + track;
    });
    return { items, width };
  });
  const maxW = Math.max(1, ...lines.map((l) => l.width));

  // 2. Font units -> drawing units.
  const s = t.fitWidth ? t.fitWidth / maxW : t.size / font.unitsPerEm;
  const size = s * font.unitsPerEm;
  const capH = capF * s;

  // 3. Radius of the curve (Infinity = straight). Positive arches upward.
  let R = Infinity;
  if (t.curve === "bend" && t.bend !== 0) R = (maxW * s) / ((t.bend / 100) * 2 * Math.PI);
  else if (t.curve === "circle" && t.radius > 0) R = t.curveDown ? -t.radius : t.radius;

  // 4. Whole-block transform: slant, baseline slope, rotation, position.
  const global = mul(
    [1, 0, 0, 1, t.x, t.y],
    mul(rot(rad(t.rotation)), mul([1, Math.tan(rad(t.slope)), 0, 1, 0, 0], [1, 0, -Math.tan(rad(t.slant)), 1, 0, 0])),
  );

  const amp = (t.wave / 100) * size;
  const waveLen = Math.max(0.2, t.waveLength) * size;
  let d = "";
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  lines.forEach((line, li) => {
    const yLine = (li - (lines.length - 1) / 2) * t.lineHeight * size;
    const lineW = line.width * s;
    for (const it of line.items) {
      if (!it.cmds.length) continue;
      const adv = it.adv * s;
      const u = it.pos * s - lineW / 2 + adv / 2; // letter centre, measured along the line

      // Where this letter's centre sits and how it is turned.
      const wy = amp ? amp * Math.sin((2 * Math.PI * u) / waveLen) : 0;
      let px = u, py = yLine, angle = amp ? Math.atan(((amp * 2 * Math.PI) / waveLen) * Math.cos((2 * Math.PI * u) / waveLen)) : 0;
      if (Number.isFinite(R)) {
        const Rl = R - yLine; // inner lines sit on smaller circles
        const phi = u / Rl;
        px = Rl * Math.sin(phi);
        py = R - Rl * Math.cos(phi);
        angle += phi;
      }
      const ks = it.k * s;
      // Letter outline (font units, y up) -> centred on its spot (y down).
      const local: M = [ks, 0, 0, -ks, -adv / 2, capH / 2 + wy];
      const m = mul(global, mul([1, 0, 0, 1, px, py], mul(rot(angle), local)));

      const P = (x: number, y: number) => {
        const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        return f2(X) + " " + f2(Y);
      };
      for (const c of it.cmds) {
        if (c.type === "M") d += "M" + P(c.x, c.y);
        else if (c.type === "L") d += "L" + P(c.x, c.y);
        else if (c.type === "C") d += "C" + P(c.x1, c.y1) + " " + P(c.x2, c.y2) + " " + P(c.x, c.y);
        else if (c.type === "Q") d += "Q" + P(c.x1, c.y1) + " " + P(c.x, c.y);
        else d += "Z";
      }
    }
  });

  const box = d ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: t.x - size / 2, y: t.y - size / 2, w: size, h: size };
  return { d, box, size };
}

// Text objects are never modified in place, so a layout can be remembered
// for as long as the object (and its font) stay the same.
const layoutCache = new WeakMap<TextObj, { entry: FontEntry; layout: TextLayout }>();
export function getLayout(t: TextObj, entry: FontEntry): TextLayout {
  const hit = layoutCache.get(t);
  if (hit && hit.entry === entry) return hit.layout;
  let layout: TextLayout;
  try {
    layout = layoutText(t, entry);
  } catch (e) {
    // A font we cannot lay out must never break the app: draw nothing instead.
    console.warn("Could not lay out text with " + entry.name, e);
    layout = { d: "", box: { x: t.x - t.size / 2, y: t.y - t.size / 2, w: t.size, h: t.size }, size: t.size };
  }
  layoutCache.set(t, { entry, layout });
  return layout;
}

/** One drawable piece of a text object (the letters, a shadow, an extrusion layer). */
export interface TextPart {
  d: string;
  fill: string;
  dx: number;
  dy: number;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

const darker = (hex: string, k = 0.6) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * The stack of pieces to draw for a text object, bottom first:
 * drop shadow, 3D extrusion layers (offset copies in a darker shade), letters.
 */
export function textParts(t: TextObj, layout: TextLayout): TextPart[] {
  if (!layout.d) return [];
  const parts: TextPart[] = [];
  const ex = Math.cos(rad(t.extrudeAngle)), ey = Math.sin(rad(t.extrudeAngle));
  const depth = Math.max(0, t.extrude);
  const outline = t.strokeWidth > 0;
  if (t.shadow) {
    parts.push({
      d: layout.d, fill: t.shadowColor, dx: t.shadowX + ex * depth, dy: t.shadowY + ey * depth, opacity: 0.45,
      ...(outline ? { stroke: t.shadowColor, strokeWidth: t.strokeWidth } : {}),
    });
  }
  if (depth > 0) {
    const steps = Math.min(40, Math.max(1, Math.ceil(depth)));
    const shade = darker(outline ? t.strokeColor : t.fill);
    for (let i = steps; i >= 1; i--) {
      const k = (depth * i) / steps;
      // A thin stroke in the same colour hides hairline gaps between the copies.
      parts.push({ d: layout.d, fill: shade, dx: ex * k, dy: ey * k, stroke: shade, strokeWidth: Math.max(t.strokeWidth, 0.5) });
    }
  }
  parts.push({ d: layout.d, fill: t.fill, dx: 0, dy: 0, ...(outline ? { stroke: t.strokeColor, strokeWidth: t.strokeWidth } : {}) });
  return parts;
}
