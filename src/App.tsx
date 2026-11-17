import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./ui/TopBar";
import CanvasView, { type ViewMode } from "./ui/CanvasView";
import CleanupPanel from "./ui/CleanupPanel";
import EditPanel from "./ui/EditPanel";
import PaletteManager from "./ui/PaletteManager";
import { imageFromDataTransfer, loadImage, type SourceImage } from "./lib/loadImage";
import { usePalettes } from "./lib/palettes";
import { defaultSettings, type CleanupSettings } from "./pipeline/types";
import { useVectorizer } from "./pipeline/useVectorizer";
import { useEditor } from "./editor/useEditor";
import { baseName, downloadText, exportSvg } from "./export/svg";

/** True when the keyboard focus is in a box where typing should not trigger shortcuts. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

export default function App() {
  const [image, setImage] = useState<SourceImage | null>(null);
  const [settings, setSettings] = useState<CleanupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("side");
  const [checkerboard, setCheckerboard] = useState(true);
  const [outlines, setOutlines] = useState(false);
  const [showShapes, setShowShapes] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [managing, setManaging] = useState(false);
  /** Eyedropper mode: the function that receives the picked colour, or null. */
  const [pick, setPick] = useState<{ use: (hex: string) => void; reopenManager: boolean } | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const palettes = usePalettes();

  // The palette only matters to the pipeline while "snap" is on; leaving it
  // out otherwise avoids re-tracing just because a palette was edited.
  const paletteKey = settings?.paletteSnap ? palettes.active.colors.join(",") : "";
  const runSettings = useMemo(
    () => settings && { ...settings, palette: paletteKey ? paletteKey.split(",") : [] },
    [settings, paletteKey],
  );

  // Runs the clean-up pipeline in a Web Worker whenever image or settings change.
  const job = useVectorizer(image, runSettings);
  // The traced shapes become an editable drawing with undo/redo.
  const ed = useEditor(job.result);

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
        ...defaultSettings(img.width, img.height, []),
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

  // Keyboard shortcuts for editing.
  const edRef = useRef(ed);
  edRef.current = ed;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ed = edRef.current;
      if (e.key === "Escape") {
        setPick(null);
        if (!isTyping(e.target)) ed.nodeEdit ? ed.setNodeEdit(false) : ed.clearSelection();
        return;
      }
      if (isTyping(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === "z") { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); }
      else if (ctrl && key === "y") { e.preventDefault(); ed.redo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && ed.selection.size) { e.preventDefault(); ed.remove(); }
      else if (e.key.startsWith("Arrow") && ed.selection.size) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        ed.nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
                 e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const hasShapes = ed.shapes.length > 0;

  /** Start the eyedropper. The palette dialog hides meanwhile and returns after. */
  const startPick = (use: (hex: string) => void) => {
    setPick({ use, reopenManager: managing });
    setManaging(false);
    // The eyedropper needs something to click on that shows both pictures.
    if (mode === "result") setMode("side");
  };
  const finishPick = (hex: string) => {
    pick?.use(hex);
    if (pick?.reopenManager) setManaging(true);
    setPick(null);
  };

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
        canExport={hasShapes}
        mode={mode}
        onMode={setMode}
        checkerboard={checkerboard}
        onToggleCheckerboard={() => setCheckerboard((c) => !c)}
        outlines={outlines}
        onToggleOutlines={() => setOutlines((o) => !o)}
        showShapes={showShapes}
        onToggleShapes={() => setShowShapes((o) => !o)}
        canUndo={ed.canUndo}
        canRedo={ed.canRedo}
        onUndo={ed.undo}
        onRedo={ed.redo}
        onOpenFile={(f) => void openFile(f, f.name)}
        onExportSvg={() => {
          if (hasShapes && image)
            downloadText(baseName(image.name) + ".svg", exportSvg({ ...ed.size, shapes: ed.shapes }), "image/svg+xml");
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
                  ...defaultSettings(image.width, image.height, []),
                  paletteSnap: settings.paletteSnap,
                })
              }
              palettes={palettes}
              onManagePalettes={() => setManaging(true)}
              edited={ed.edited}
              result={job.result}
              busy={job.busy}
              stage={job.stage}
              fraction={job.fraction}
            />
            <CanvasView
              image={image}
              ed={ed}
              mode={mode}
              checkerboard={checkerboard}
              outlines={outlines}
              showShapes={showShapes}
              onPickColor={pick ? finishPick : null}
            />
            <EditPanel ed={ed} palette={palettes.active.colors} onPick={startPick} />
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

      {managing && (
        <PaletteManager
          store={palettes}
          resultColors={ed.groups.map((g) => g.fill)}
          onPick={startPick}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  );
}
