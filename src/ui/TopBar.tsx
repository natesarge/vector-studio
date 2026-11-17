import { useRef } from "react";
import type { ViewMode } from "./CanvasView";

const MODES: { id: ViewMode; label: string; hint: string }[] = [
  { id: "original", label: "Original", hint: "Show the image you opened" },
  { id: "result", label: "Result", hint: "Show the vector result" },
  { id: "side", label: "Side by side", hint: "Original and result next to each other" },
  { id: "slider", label: "Slider", hint: "Drag a divider across the image to compare" },
];

interface Props {
  fileLabel: string | null;
  hasImage: boolean;
  canExport: boolean;
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
  checkerboard: boolean;
  onToggleCheckerboard: () => void;
  outlines: boolean;
  onToggleOutlines: () => void;
  showShapes: boolean;
  onToggleShapes: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onOpenFile: (file: File) => void;
  onExportSvg: () => void;
}

/** The strip across the top: app name, Open, view modes, toggles and Export. */
export default function TopBar(p: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <circle cx="16" cy="16" r="15" fill="#EFD8B1" />
          <path d="M9 22 16 8l7 14z" fill="#EE6A01" />
        </svg>
        <span>Caveman Vector Studio</span>
      </div>

      <button className="primary" onClick={() => inputRef.current?.click()}>
        Open image
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onOpenFile(f);
          e.target.value = ""; // allow re-opening the same file
        }}
      />

      {p.fileLabel && <span className="file-label">{p.fileLabel}</span>}

      <div className="spacer" />

      {p.hasImage && (
        <>
          <button disabled={!p.canUndo} onClick={p.onUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶ Undo</button>
          <button disabled={!p.canRedo} onClick={p.onRedo} title="Redo (Ctrl+Y)" aria-label="Redo">↷ Redo</button>
          <div className="segmented" role="radiogroup" aria-label="View mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={p.mode === m.id}
                className={p.mode === m.id ? "on" : ""}
                title={m.hint}
                onClick={() => p.onMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="toggle" title="Show shape outlines instead of filled colors">
            <input type="checkbox" checked={p.outlines} onChange={p.onToggleOutlines} />
            Outlines
          </label>
          <label className="toggle" title="Draw a thin line around every individual shape">
            <input type="checkbox" checked={p.showShapes} onChange={p.onToggleShapes} />
            Shapes
          </label>
          <label className="toggle" title="Show a checkerboard behind transparent areas">
            <input type="checkbox" checked={p.checkerboard} onChange={p.onToggleCheckerboard} />
            Checkerboard
          </label>
          <button disabled={!p.canExport} onClick={p.onExportSvg} title="Save the result as an SVG vector file">
            Export SVG
          </button>
        </>
      )}
    </header>
  );
}
