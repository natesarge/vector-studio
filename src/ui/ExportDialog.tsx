import { useState } from "react";

export type ExportFormat = "svg" | "pdf" | "png" | "cut";

export interface ExportOptions {
  format: ExportFormat;
  /** Sticker border: a solid edge around the whole design. */
  border: boolean;
  /** Border width in drawing pixels. */
  borderWidth: number;
  borderColor: string;
  /** Printed width in inches (PDF page size, and PNG size together with dpi). */
  widthIn: number;
  dpi: number;
}

interface Props {
  /** Size of the drawing in its own pixels. */
  width: number;
  height: number;
  /** Runs the export; resolves when the file has been handed to the browser. */
  onExport: (o: ExportOptions) => Promise<void>;
  onClose: () => void;
}

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "svg", label: "SVG", hint: "Editable vector file, grouped by color. Text becomes outlines." },
  { id: "pdf", label: "PDF", hint: "Vector PDF for print shops, one page the size of the design." },
  { id: "png", label: "PNG", hint: "Picture with a transparent background at the size you choose." },
  { id: "cut", label: "Cut line", hint: "SVG with only the outer outline as one thin magenta line, for sticker die-cutting." },
];

/** Dialog for choosing a file format and its options. */
export default function ExportDialog({ width, height, onExport, onClose }: Props) {
  const [o, setO] = useState<ExportOptions>({
    format: "svg", border: false, borderWidth: Math.round(width / 40), borderColor: "#FFFFFF", widthIn: 3, dpi: 300,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ExportOptions>) => setO((old) => ({ ...old, ...patch }));

  const pad = o.border ? o.borderWidth * 2 : 0;
  const ratio = (height + pad) / (width + pad);
  const pxW = Math.round(o.widthIn * o.dpi), pxH = Math.round(pxW * ratio);
  const sized = o.format === "pdf" || o.format === "png";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onExport(o);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-label="Export" aria-modal="true">
        <div className="modal-head">
          <h2>Export</h2>
          <button className="link" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="modal-body column">
          <div className="segmented fill" role="radiogroup" aria-label="File format">
            {FORMATS.map((f) => (
              <button key={f.id} role="radio" aria-checked={o.format === f.id} className={o.format === f.id ? "on" : ""} onClick={() => set({ format: f.id })}>
                {f.label}
              </button>
            ))}
          </div>
          <p className="fine top">{FORMATS.find((f) => f.id === o.format)!.hint}</p>

          {sized && (
            <div className="form-row">
              <label>
                Print width
                <input type="number" aria-label="Print width in inches" min={0.25} max={60} step={0.25} value={o.widthIn}
                  onChange={(e) => set({ widthIn: Math.max(0.1, Number(e.target.value)) })} /> in
              </label>
              {o.format === "png" && (
                <label>
                  Resolution
                  <input type="number" aria-label="Resolution in DPI" min={36} max={1200} step={1} value={o.dpi}
                    onChange={(e) => set({ dpi: Math.max(1, Number(e.target.value)) })} /> DPI
                </label>
              )}
            </div>
          )}
          {o.format === "png" && (
            <p className="fine top" data-testid="png-size">
              {pxW} × {pxH} pixels ({o.widthIn} × {(o.widthIn * ratio).toFixed(2)} in at {o.dpi} DPI)
              {Math.max(pxW, pxH) > 8000 ? " · very large; your browser may refuse it" : ""}
            </p>
          )}
          {o.format === "pdf" && (
            <p className="fine top">Page size {o.widthIn} × {(o.widthIn * ratio).toFixed(2)} in. Vector, so it stays sharp at any size.</p>
          )}

          <label className="check" title="Adds a solid edge around the whole design, like the white border of a sticker">
            <input type="checkbox" checked={o.border} onChange={(e) => set({ border: e.target.checked })} />
            {o.format === "cut" ? "Cut outside a sticker border" : "Add a sticker border"}
          </label>
          {o.border && (
            <div className="form-row">
              <label>
                Border width
                <input type="number" aria-label="Sticker border width" min={1} max={Math.round(width / 4)} value={o.borderWidth}
                  onChange={(e) => set({ borderWidth: Math.max(1, Number(e.target.value)) })} /> px
              </label>
              {o.format !== "cut" && (
                <label>
                  Color
                  <input type="color" aria-label="Sticker border color" value={o.borderColor}
                    onChange={(e) => set({ borderColor: e.target.value.toUpperCase() })} />
                </label>
              )}
            </div>
          )}
          {o.border && (
            <p className="fine top">
              The design is {width} px wide, so {o.borderWidth} px is {((o.borderWidth / width) * 100).toFixed(1)}% of its width
              {sized ? ` (${((o.borderWidth / (width + pad)) * o.widthIn).toFixed(2)} in when printed)` : ""}.
            </p>
          )}

          {error && <p className="fine error-text" role="alert">{error}</p>}
          <div className="form-row end">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy} onClick={run} data-testid="export-go">
              {busy ? "Exporting…" : "Export " + FORMATS.find((f) => f.id === o.format)!.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
