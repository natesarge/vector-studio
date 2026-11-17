// Building SVG text from the drawing, and saving files from the browser.
import type { TextPart } from "../text/layout";

/** The minimum needed to write a file: size plus stacked, filled paths. */
export interface Drawing {
  width: number;
  height: number;
  shapes: { d: string; fill: string }[];
  /** Text objects, already converted to outline pieces (bottom piece first). */
  texts?: TextPart[][];
}

const n2 = (v: number) => Math.round(v * 100) / 100;
/** One text piece as an SVG <path>. Outlines are drawn behind the fill. */
export const textPartTag = (p: TextPart) =>
  `<path d="${p.d}" fill="${p.fill}"` +
  (p.dx || p.dy ? ` transform="translate(${n2(p.dx)} ${n2(p.dy)})"` : "") +
  (p.stroke && p.strokeWidth ? ` stroke="${p.stroke}" stroke-width="${n2(p.strokeWidth * 2)}" stroke-linejoin="round" paint-order="stroke"` : "") +
  (p.opacity !== undefined ? ` opacity="${p.opacity}"` : "") +
  `/>`;

/**
 * Clean SVG file. Shapes stay in drawing order (later shapes sit on top of
 * earlier ones), and neighbours of the same colour share one <g> group.
 */
export function exportSvg(r: Drawing): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}">`,
  ];
  for (let i = 0; i < r.shapes.length; ) {
    const fill = r.shapes[i].fill;
    let j = i;
    while (j < r.shapes.length && r.shapes[j].fill === fill) j++;
    lines.push(`  <g fill="${fill}">`);
    for (let n = i; n < j; n++) lines.push(`    <path d="${r.shapes[n].d}"/>`);
    lines.push(`  </g>`);
    i = j;
  }
  // Text is written as plain outlines, so no font is needed to open the file.
  (r.texts ?? []).forEach((parts, i) => {
    if (!parts.length) return;
    lines.push(`  <g id="text-${i + 1}">`);
    for (const p of parts) lines.push("    " + textPartTag(p));
    lines.push(`  </g>`);
  });
  lines.push(`</svg>`, "");
  return lines.join("\n");
}

/** Save text as a file through the browser's normal download mechanism. */
export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "my logo.png" -> "my logo" */
export const baseName = (name: string) => name.replace(/\.[^.]+$/, "") || "image";
