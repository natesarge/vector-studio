// PNG and PDF export. Both start from the same SVG text as the SVG export,
// so every format shows exactly the same drawing.

/** Size (width, height) written in an SVG's opening tag. */
function svgSize(svg: string): { w: number; h: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(svg), h = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg);
  return { w: w ? Number(w[1]) : 1, h: h ? Number(h[1]) : 1 };
}

// ---------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Write the print resolution into a PNG (its "pHYs" chunk), so programs that
 * honour it open the image at the intended physical size.
 */
function withDpi(png: Uint8Array, dpi: number): Uint8Array {
  const perMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21); // length(4) + "pHYs"(4) + data(9) + crc(4)
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // right after the 8-byte signature and the 25-byte IHDR chunk
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at));
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

/** Draw SVG text onto a canvas `widthPx` wide and return a transparent PNG. */
export async function svgToPng(svg: string, widthPx: number, dpi: number): Promise<Blob> {
  const { w, h } = svgSize(svg);
  const width = Math.max(1, Math.round(widthPx)), height = Math.max(1, Math.round((widthPx * h) / w));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("The drawing could not be rendered as an image."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This size is too large for the browser. Try a smaller PNG.");
    g.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (!blob) throw new Error("This size is too large for the browser. Try a smaller PNG.");
    return new Blob([withDpi(new Uint8Array(await blob.arrayBuffer()), dpi) as BlobPart], { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- PDF
/**
 * Vector PDF, one page exactly the size of the drawing, `widthInches` wide.
 * The PDF libraries are large, so they are only downloaded when first needed.
 */
export async function svgToPdf(svg: string, widthInches: number): Promise<Blob> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const { w, h } = svgSize(svg);
  const wPt = widthInches * 72, hPt = (wPt * h) / w;
  const pdf = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation: wPt > hPt ? "landscape" : "portrait" });
  // svg2pdf reads a real SVG element, so parse the text and attach it off-screen.
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden";
  holder.innerHTML = svg.replace(/^<\?xml[^>]*\?>\s*/, "");
  document.body.appendChild(holder);
  try {
    await pdf.svg(holder.firstElementChild!, { x: 0, y: 0, width: wPt, height: hPt });
  } finally {
    holder.remove();
  }
  return pdf.output("blob");
}
