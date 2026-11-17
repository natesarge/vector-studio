import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./ui/TopBar";
import CanvasView, { type ViewMode } from "./ui/CanvasView";
import CleanupPanel from "./ui/CleanupPanel";
import { imageFromDataTransfer, loadImage, type SourceImage } from "./lib/loadImage";
import { HAPPY_CAVEMAN } from "./lib/palettes";
import { defaultSettings, type CleanupSettings } from "./pipeline/types";
import { useVectorizer } from "./pipeline/useVectorizer";
import { baseName, downloadText, exportSvg } from "./export/svg";

export default function App() {
  const [image, setImage] = useState<SourceImage | null>(null);
  const [settings, setSettings] = useState<CleanupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("side");
  const [checkerboard, setCheckerboard] = useState(true);
  const [outlines, setOutlines] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const palette = HAPPY_CAVEMAN;

  // Runs the clean-up pipeline in a Web Worker whenever image or settings change.
  const job = useVectorizer(image, settings);

  /** Open an image from any source (button, drag-drop, paste). */
  const openFile = useCallback(async (file: Blob, name = "pasted image") => {
    try {
      const img = await loadImage(file, name);
      setImage((old) => {
        old?.bitmap.close(); // free the previous image's memory
        return img;
      });
      // Fresh starting settings for this image, keeping the palette choice.
      setSettings((old) => ({
        ...defaultSettings(img.width, img.height, HAPPY_CAVEMAN.colors),
        paletteSnap: old?.paletteSnap ?? false,
      }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Paste an image from the clipboard anywhere on the page (Ctrl+V).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = imageFromDataTransfer(e.clipboardData);
      if (f) {
        e.preventDefault();
        void openFile(f, f.name && f.name !== "image.png" ? f.name : "pasted image");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [openFile]);

  // Drag a file from the desktop onto the window.
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current++;
    setDropHover(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    if (--dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDropHover(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropHover(false);
    const f = imageFromDataTransfer(e.dataTransfer);
    if (f) void openFile(f, f.name);
    else setError("Drop a PNG, JPG or WebP image file.");
  };

  const fileLabel = image
    ? `${image.name} · ${image.width} × ${image.height} px` +
      (image.wasDownscaled ? " (scaled down)" : "")
    : null;
  const shownError = error ?? (job.error ? "Processing failed: " + job.error : null);

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={onDrop}
    >
      <TopBar
        fileLabel={fileLabel}
        hasImage={!!image}
        canExport={!!job.result}
        mode={mode}
        onMode={setMode}
        checkerboard={checkerboard}
        onToggleCheckerboard={() => setCheckerboard((c) => !c)}
        outlines={outlines}
        onToggleOutlines={() => setOutlines((o) => !o)}
        onOpenFile={(f) => void openFile(f, f.name)}
        onExportSvg={() => {
          if (job.result && image)
            downloadText(baseName(image.name) + ".svg", exportSvg(job.result), "image/svg+xml");
        }}
      />

      {shownError && (
        <div className="error-bar" role="alert">
          <span>{shownError}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        {image && settings ? (
          <>
            <CleanupPanel
              settings={settings}
              onChange={(patch) => setSettings((old) => old && { ...old, ...patch })}
              onReset={() =>
                setSettings({
                  ...defaultSettings(image.width, image.height, palette.colors),
                  paletteSnap: settings.paletteSnap,
                })
              }
              palette={palette}
              result={job.result}
              busy={job.busy}
              stage={job.stage}
              fraction={job.fraction}
            />
            <CanvasView
              image={image}
              result={job.result}
              mode={mode}
              checkerboard={checkerboard}
              outlines={outlines}
            />
          </>
        ) : (
          <div className="empty">
            <div className="empty-card">
              <h1>Turn an image into clean vector art</h1>
              <p>
                Drop a logo, sticker or patch image here, paste it with <kbd>Ctrl</kbd>+<kbd>V</kbd>,
                or choose a file.
              </p>
              <button className="primary large" onClick={() => pickerRef.current?.click()}>
                Open image
              </button>
              <input
                ref={pickerRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void openFile(f, f.name);
                  e.target.value = "";
                }}
              />
              <p className="fine">Everything runs in your browser. Your images never leave this computer.</p>
            </div>
          </div>
        )}
        {dropHover && <div className="drop-overlay">Drop the image to open it</div>}
      </main>
    </div>
  );
}
