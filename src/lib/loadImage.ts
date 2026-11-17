// Loading a user's image entirely in the browser. Nothing is uploaded anywhere.

/** Largest side we accept. Bigger images are scaled down on load. */
export const MAX_SIDE = 4000;

export interface SourceImage {
  name: string;
  width: number;
  height: number;
  /** Decoded pixels, ready to draw on a canvas or send to a worker. */
  bitmap: ImageBitmap;
  /** True when the file was larger than MAX_SIDE and we shrank it. */
  wasDownscaled: boolean;
}

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];

export function isImageFile(file: Blob): boolean {
  return ACCEPTED.includes(file.type);
}

/** Decode a file/blob into a SourceImage. Throws a readable Error on failure. */
export async function loadImage(file: Blob, name = "image"): Promise<SourceImage> {
  if (!isImageFile(file)) {
    throw new Error("That file is not a supported image (use PNG, JPG or WebP).");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("The image could not be read. It may be damaged.");
  }

  let wasDownscaled = false;
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest > MAX_SIDE) {
    const k = MAX_SIDE / longest;
    const small = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * k),
      resizeHeight: Math.round(bitmap.height * k),
      resizeQuality: "high",
    });
    bitmap.close();
    bitmap = small;
    wasDownscaled = true;
  }
  return { name, width: bitmap.width, height: bitmap.height, bitmap, wasDownscaled };
}

/** First image found in a drop or paste event's data, if any. */
export function imageFromDataTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f && isImageFile(f)) return f;
    }
  }
  for (const f of Array.from(data.files)) if (isImageFile(f)) return f;
  return null;
}
