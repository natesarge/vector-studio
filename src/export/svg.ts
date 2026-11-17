// Building SVG text from the drawing, and saving files from the browser.
import type { TextPart } from "../text/layout";
import { offsetOutline, outerOutline } from "./outline";

/** The minimum needed to write a file: size plus stacked, filled paths. */
export interface Drawing {
  width: number;
  height: number;
  shapes: { d: string; fill: string }[];
  /** Text objects, already converted to outline pieces (bottom piece first). */
  texts?: TextPart[][];
}

/** Optional solid border around the whole design, like the white edge of a sticker. */
export interface StickerBorder {
  /** Width in drawing units. */
  width: number;
  color: string;
}

const n2 = (v: number) => Math.round(v * 100) / 100;
/** One text piece as an SVG <path>. */
export const textPartTag = (p: TextPart) =>
  `<path d="${p.d}" fill="${p.fill}"` +
  (p.dx || p.dy ? ` transform="translate(${n2(p.dx)} ${n2(p.dy)})"` : "") +
  (p.stroke && p.strokeWidth ? ` stroke="${p.stroke}" stroke-width="${n2(p.strokeWidth * 2)}" stroke-linejoin="round"` : "") +
  (p.opacity !== undefined ? ` opacity="${p.opacity}"` : "") +
  `/>`;

/** Opening <svg> tag. `pad` adds room on every side (for a sticker border). */
function header(r: Drawing, pad: number): string[] {
  const w = n2(r.width + pad * 2), h = n2(r.height + pad * 2);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${n2(-pad)} ${n2(-pad)} ${w} ${h}">`,
  ];
}

/**
 * Clean SVG file. Shapes stay in drawing order (later shapes sit on top of
 * earlier ones), and neighbours of the same colour share one <g> group.
 * Text is written as plain outlines, so no font is needed to open the file.
 */
export function exportSvg(r: Drawing, border?: StickerBorder | null): string {
  const pad = border ? border.width : 0;
  const lines = header(r, pad);
  if (border) {
    const edge = offsetOutline(outerOutline(r.shapes), border.width);
    if (edge) lines.push(`  <path id="sticker-border" d="${edge}" fill="${border.color}"/>`);
  }
  for (let i = 0; i < r.shapes.length; ) {
    const fill = r.shapes[i].fill;
    let j = i;
    while (j < r.shapes.length && r.shapes[j].fill === fill) j++;
    lines.push(`  <g fill="${fill}">`);
    for (let n = i; n < j; n++) lines.push(`    <path d="${r.shapes[n].d}"/>`);
    lines.push(`  </g>`);
    i = j;
  }
  (r.texts ?? []).forEach((parts, i) => {
    if (!parts.length) return;
    lines.push(`  <g id="text-${i + 1}">`);
    for (const p of parts) lines.push("    " + textPartTag(p));
    lines.push(`  </g>`);
  });
  lines.push(`</svg>`, "");
  return lines.join("\n");
}

/**
 * Cut line: only the outer outline, as one thin line in a single colour, for
 * sticker die-cutting. `offset` moves the line outward (to cut around a border).
 */
export function exportCutLine(r: Drawing, offset = 0): string {
  const lines = header(r, offset);
  const edge = offsetOutline(outerOutline(r.shapes), offset);
  lines.push(`  <path id="cut-line" d="${edge}" fill="none" stroke="#FF00FF" stroke-width="1"/>`, `</svg>`, "");
  return lines.join("\n");
}

/** Save a file through the browser's normal download mechanism. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadText = (filename: string, text: string, mime: string) =>
  downloadBlob(filename, new Blob([text], { type: mime }));

/** "my logo.png" -> "my logo" */
export const baseName = (name: string) => name.replace(/\.[^.]+$/, "") || "image";
