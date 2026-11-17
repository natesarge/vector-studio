// Project files (".cvs.json"): everything needed to reopen work later or on
// another computer. One JSON file holding the original image, the clean-up
// settings, the edited shapes, the text objects and any extra fonts they use.

import type { DocShape } from "../editor/useEditor";
import type { SourceImage } from "../lib/loadImage";
import type { CleanupSettings } from "../pipeline/types";
import { addFont, getFont } from "../text/fonts";
import type { TextObj } from "../text/layout";

export const PROJECT_EXT = ".cvs.json";

interface SavedFont {
  id: string;
  name: string;
  source: "upload" | "google";
  /** The font file, base64-encoded. */
  data: string;
}

export interface ProjectFile {
  app: "caveman-vector-studio";
  version: 1;
  image: { name: string; dataUrl: string };
  settings: CleanupSettings;
  size: { width: number; height: number };
  shapes: { d: string; fill: string }[];
  texts: TextObj[];
  fonts: SavedFont[];
  palette: { name: string; colors: string[] };
}

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

/** Build the project file's text. */
export function saveProject(p: {
  image: SourceImage;
  settings: CleanupSettings;
  size: { width: number; height: number };
  shapes: DocShape[];
  texts: TextObj[];
  palette: { name: string; colors: string[] };
}): string {
  // The original picture, stored losslessly so re-tracing gives the same result.
  const canvas = document.createElement("canvas");
  canvas.width = p.image.width;
  canvas.height = p.image.height;
  canvas.getContext("2d")!.drawImage(p.image.bitmap, 0, 0);

  // Fonts that do not ship with the app must travel with the project.
  const fonts: SavedFont[] = [];
  for (const id of new Set(p.texts.map((t) => t.fontId))) {
    const f = getFont(id);
    if (f && f.source !== "bundled") fonts.push({ id: f.id, name: f.name, source: f.source, data: toBase64(f.bytes) });
  }

  const file: ProjectFile = {
    app: "caveman-vector-studio",
    version: 1,
    image: { name: p.image.name, dataUrl: canvas.toDataURL("image/png") },
    settings: p.settings,
    size: p.size,
    shapes: p.shapes.map(({ d, fill }) => ({ d, fill })),
    texts: p.texts,
    fonts,
    palette: { name: p.palette.name, colors: p.palette.colors },
  };
  return JSON.stringify(file);
}

/** Read and check a project file. Throws a readable error if it is not one of ours. */
export async function readProject(text: string): Promise<{ file: ProjectFile; imageBlob: Blob }> {
  let file: ProjectFile;
  try {
    file = JSON.parse(text) as ProjectFile;
  } catch {
    throw new Error("That file is not a valid project file.");
  }
  if (file?.app !== "caveman-vector-studio" || !file.image?.dataUrl || !Array.isArray(file.shapes)) {
    throw new Error("That file is not a Caveman Vector Studio project.");
  }
  if (file.version !== 1) throw new Error("This project was saved by a newer version of the app.");
  for (const f of file.fonts ?? []) {
    try {
      addFont(f.id, f.name, f.source, fromBase64(f.data));
    } catch {
      // a font that fails to load leaves its text undrawn rather than blocking the project
    }
  }
  const imageBlob = await (await fetch(file.image.dataUrl)).blob();
  return { file, imageBlob };
}
