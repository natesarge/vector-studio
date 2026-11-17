// Building SVG text from traced shapes, and saving files from the browser.
import type { Shape, TraceResult } from "../pipeline/types";

const pathTag = (s: Shape, withFill: boolean) =>
  `<path d="${s.d}"${withFill ? ` fill="${s.fill}"` : ""}${s.transform ? ` transform="${s.transform}"` : ""}/>`;

/** Compact SVG for showing on screen (stretched to fit its container). */
export function previewSvg(r: TraceResult): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.width} ${r.height}" preserveAspectRatio="none">` +
    r.shapes.map((s) => pathTag(s, true)).join("") +
    `</svg>`
  );
}

/**
 * Clean SVG file. Shapes stay in drawing order (later shapes sit on top of
 * earlier ones), and neighbours of the same colour share one <g> group.
 */
export function exportSvg(r: TraceResult): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}">`,
  ];
  for (let i = 0; i < r.shapes.length; ) {
    const fill = r.shapes[i].fill;
    let j = i;
    while (j < r.shapes.length && r.shapes[j].fill === fill) j++;
    lines.push(`  <g fill="${fill}">`);
    for (let n = i; n < j; n++) lines.push("    " + pathTag(r.shapes[n], false));
    lines.push(`  </g>`);
    i = j;
  }
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
