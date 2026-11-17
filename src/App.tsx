import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./ui/TopBar";
import CanvasView, { type ViewMode } from "./ui/CanvasView";
import CleanupPanel from "./ui/CleanupPanel";
import EditPanel from "./ui/EditPanel";
import PaletteManager from "./ui/PaletteManager";
import TextPanel from "./ui/TextPanel";
import FontPicker from "./ui/FontPicker";
import { DEFAULT_FONT, getFont, loadBundledFonts } from "./text/fonts";
import { defaultText, getLayout, textParts } from "./text/layout";
import { findLettering, type Pt } from "./text/lettering";
import { absorb } from "./editor/pathops";
import type { RegionTool } from "./editor/useEditor";
import { imageFromDataTransfer, loadImage, type SourceImage } from "./lib/loadImage";
import { usePalettes } from "./lib/palettes";
import { defaultSettings, type CleanupSettings } from "./pipeline/types";
import { useVectorizer } from "./pipeline/useVectorizer";
import { newId, useEditor } from "./editor/useEditor";
import { baseName, downloadBlob, downloadText, exportCutLine, exportSvg } from "./export/svg";
import { svgToPdf, svgToPng } from "./export/raster";
import { PROJECT_EXT, readProject, saveProject } from "./export/project";
import ExportDialog, { type ExportOptions } from "./ui/ExportDialog";

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
  const [rightTab, setRightTab] = useState<"shapes" | "text">("shapes");
  const [fontPicker, setFontPicker] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Print width in inches, shared by the Export dialog and the ring size readout. */
  const [printWidthIn, setPrintWidthIn] = useState(3);
  /** Compare: show the original in place of the result. Held (button or C) or locked on. */
  const [compareHeld, setCompareHeld] = useState(false);
  const [compareLocked, setCompareLocked] = useState(false);
  const compare = compareHeld || compareLocked;
  /** Message shown at the bottom of the Shapes panel (results of Knife, Merge, ...). */
  const [editNote, setEditNote] = useState<string | null>(null);
  const [textNote, setTextNote] = useState<string | null>(null);
  /** Font used for new text: whatever the user chose last. */
  const lastFont = useRef(DEFAULT_FONT);
  useEffect(loadBundledFonts, []);

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
  const edRef = useRef(ed);
  edRef.current = ed;

  /** Open an image or a saved project from any source (button, drag-drop, paste). */
  const openFile = useCallback(async (file: Blob, name = "pasted image") => {
    try {
      if (name.toLowerCase().endsWith(".json")) {
        // A saved project: restore the image, settings, drawing and fonts.
        const { file: proj, imageBlob } = await readProject(await file.text());
        const img = await loadImage(imageBlob, proj.image.name);
        setImage((old) => {
          old?.bitmap.close();
          return img;
        });
        // Projects saved before "border mode" existed had a simple on/off switch.
        const old = proj.settings as Partial<CleanupSettings> & { border?: boolean };
        const borderMode = old.borderMode ?? (old.border === false ? "off" : "redraw");
        setSettings({ ...defaultSettings(img.width, img.height, []), ...proj.settings, borderMode });
        edRef.current.loadDoc({ shapes: proj.shapes, texts: proj.texts ?? [] }, proj.size);
        setError(null);
        return;
      }
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ed = edRef.current;
      if (e.key === "Escape") {
        setPick(null);
        ed.setRegionTool(null);
        if (!isTyping(e.target)) ed.nodeEdit ? ed.setNodeEdit(false) : ed.clearSelection();
        return;
      }
      if (isTyping(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      // C: hold to compare with the original; Shift+C: switch compare on/off.
      if (e.code === "KeyC" && !ctrl && !e.altKey) {
        if (!e.repeat) e.shiftKey ? setCompareLocked((v) => !v) : setCompareHeld(true);
        return;
      }
      const key = e.key.toLowerCase();
      if (ctrl && key === "z") { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); }
      else if (ctrl && key === "y") { e.preventDefault(); ed.redo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && ed.nodeEdit && ed.nodeSel.size) { e.preventDefault(); ed.removeSelectedNodes(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && (ed.selection.size || ed.selectedText)) { e.preventDefault(); ed.remove(); }
      else if (e.key.startsWith("Arrow") && (ed.selection.size || ed.selectedText)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        ed.nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
                 e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => e.code === "KeyC" && setCompareHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => setCompareHeld(false));
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
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
    const any = e.dataTransfer.files[0];
    if (f) void openFile(f, f.name);
    else if (any?.name.toLowerCase().endsWith(".json")) void openFile(any, any.name);
    else setError("Drop a PNG, JPG or WebP image, or a .cvs.json project file.");
  };

  const fileLabel = image
    ? `${image.name} · ${image.width} × ${image.height} px` +
      (image.wasDownscaled ? " (scaled down)" : "")
    : null;
  const shownError = error ?? (job.error ? "Processing failed: " + job.error : null);
  const hasShapes = ed.shapes.length > 0;

  // ---- text
  const addText = () => {
    const { width, height } = ed.size;
    ed.addText(defaultText(newId(), lastFont.current, width / 2, height / 2, Math.round(width / 10)));
    if (mode === "original") setMode("result");
  };
  /** The user drew a box or lasso: swap the traced lettering inside it for real text. */
  const replaceLettering = (region: Pt[]) => {
    ed.setRegionTool(null);
    const match = findLettering(ed.shapes, region);
    if (!match) {
      setTextNote("No complete shapes found inside that area. Draw a slightly larger box around the whole word.");
      return;
    }
    const text = { ...defaultText(newId(), lastFont.current, 0, 0, 100), ...match.fit };
    // Merge the old letters into the shape around them, so no hole is left behind.
    const remove = new Set(ed.shapes.flatMap((s, i) => (match.removeIds.has(s.id) ? [i] : [])));
    ed.setDoc({ shapes: absorb(ed.shapes, remove), texts: [...ed.texts, text] });
    ed.selectText(text.id);
    setTextNote(`Replaced ${match.removeIds.size} shapes with ${match.layout === "arc" ? "curved" : "straight"} text. Type the wording and pick a font.`);
  };
  /** A box, lasso or knife line was drawn on the picture. */
  const onRegion = (pts: Pt[], tool: RegionTool) => {
    if (tool === "box" || tool === "lasso") return replaceLettering(pts);
    ed.setRegionTool(null);
    setEditNote(ed.knife(pts, tool === "knifeLine" ? "line" : "lasso"));
  };
  if (ed.selectedText) lastFont.current = ed.selectedText.fontId;
  // Selecting a text on the picture brings up its controls.
  const selectedTextId = ed.selectedText?.id;
  useEffect(() => {
    if (selectedTextId !== undefined) setRightTab("text");
  }, [selectedTextId]);

  const tabs = (
    <div className="segmented fill" role="tablist" aria-label="Edit panel">
      <button role="tab" aria-selected={rightTab === "shapes"} className={rightTab === "shapes" ? "on" : ""} onClick={() => setRightTab("shapes")}>
        Shapes
      </button>
      <button role="tab" aria-selected={rightTab === "text"} className={rightTab === "text" ? "on" : ""} onClick={() => setRightTab("text")}>
        Text
      </button>
    </div>
  );
  /** Text objects as outline pieces, for export. */
  const textOutlines = () =>
    ed.texts.flatMap((t) => {
      const font = getFont(t.fontId);
      return font ? [textParts(t, getLayout(t, font))] : [];
    });

  // ---- export and project files
  const drawing = () => ({ ...ed.size, shapes: ed.shapes, texts: textOutlines() });
  const doExport = async (o: ExportOptions) => {
    if (!image) return;
    const name = baseName(image.name);
    const border = o.border ? { width: o.borderWidth, color: o.borderColor } : null;
    if (o.format === "cut") return downloadText(name + "-cutline.svg", exportCutLine(drawing(), border?.width ?? 0), "image/svg+xml");
    // PNG: one output pixel of hairline (see exportSvg) so shared edges render seamlessly.
    const hairline = o.format === "png" ? (ed.size.width + (border ? border.width * 2 : 0)) / (o.widthIn * o.dpi) : 0;
    const svg = exportSvg(drawing(), border, { hairline });
    if (o.format === "svg") downloadText(name + ".svg", svg, "image/svg+xml");
    else if (o.format === "png") downloadBlob(name + ".png", await svgToPng(svg, o.widthIn * o.dpi, o.dpi));
    else downloadBlob(name + ".pdf", await svgToPdf(svg, o.widthIn));
  };
  const saveProjectFile = () => {
    if (!image || !settings) return;
    downloadText(
      baseName(image.name) + PROJECT_EXT,
      saveProject({ image, settings, size: ed.size, shapes: ed.shapes, texts: ed.texts, palette: palettes.active }),
      "application/json",
    );
  };

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
        compare={compare}
        compareLocked={compareLocked}
        onCompareHold={setCompareHeld}
        onCompareToggle={() => setCompareLocked((v) => !v)}
        onRedo={ed.redo}
        onOpenFile={(f) => void openFile(f, f.name)}
        onExport={() => setExporting(true)}
        onSaveProject={saveProjectFile}
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
              printWidthIn={printWidthIn}
              onPick={startPick}
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
              onRegion={onRegion}
              compare={compare}
            />
            {rightTab === "shapes" ? (
              <EditPanel ed={ed} tabs={tabs} palette={palettes.active.colors} onPick={startPick} note={editNote} setNote={setEditNote} />
            ) : (
              <TextPanel
                ed={ed}
                tabs={tabs}
                palette={palettes.active.colors}
                onPick={startPick}
                onAddText={addText}
                onGoogleFonts={() => setFontPicker(true)}
                note={textNote}
              />
            )}
          </>
        ) : (
          <div className="empty">
            <div className="empty-card">
              <h1>Turn an image into clean vector art</h1>
              <p>
                Drop a logo, sticker or patch image here, paste it with <kbd>Ctrl</kbd>+<kbd>V</kbd>,
                or choose a file. Saved projects (.cvs.json) open the same way.
              </p>
              <button className="primary large" onClick={() => pickerRef.current?.click()}>
                Open image
              </button>
              <input
                ref={pickerRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,.json"
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

      {exporting && (
        <ExportDialog
          width={ed.size.width}
          height={ed.size.height}
          widthIn={printWidthIn}
          onWidthIn={setPrintWidthIn}
          onExport={doExport}
          onClose={() => setExporting(false)}
        />
      )}

      {fontPicker && (
        <FontPicker
          onClose={() => setFontPicker(false)}
          onAdded={(font) => {
            if (ed.selectedText) ed.updateText(ed.selectedText.id, { fontId: font.id });
            lastFont.current = font.id;
            setFontPicker(false);
          }}
        />
      )}

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
