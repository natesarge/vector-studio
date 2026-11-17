import { useRef, useState } from "react";
import { isHex } from "../pipeline/color";
import { downloadText } from "../export/svg";
import { importPalettes, newPalette, paletteToJson, paletteToText, type Palettes } from "../lib/palettes";

interface Props {
  store: Palettes;
  /** Colours of the current result, offered as a quick way to fill a palette. */
  resultColors: string[];
  /** Hide the dialog, let the user click the picture, then call back with the colour. */
  onPick: (use: (hex: string) => void) => void;
  onClose: () => void;
}

/** Dialog for creating, editing, importing and exporting colour palettes. */
export default function PaletteManager({ store, resultColors, onPick, onClose }: Props) {
  const p = store.active;
  const [hex, setHex] = useState("#");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addColor = (c: string) => {
    const v = (c.startsWith("#") ? c : "#" + c).toUpperCase();
    if (!isHex(v)) return setError("Type a color like #EE6A01.");
    setError(null);
    if (!p.colors.includes(v)) store.update({ ...p, colors: [...p.colors, v] });
    setHex("#");
  };
  const fileName = p.name.replace(/[^\w-]+/g, "_") || "palette";

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Palettes" aria-modal="true">
        <div className="modal-head">
          <h2>Palettes</h2>
          <button className="link" onClick={onClose} aria-label="Close">Close</button>
        </div>

        <div className="modal-body">
          <ul className="palette-list" aria-label="Saved palettes">
            {store.palettes.map((q) => (
              <li key={q.id}>
                <button className={q.id === p.id ? "on" : ""} onClick={() => store.setActive(q.id)}>
                  <span>{q.name}</span>
                  <span className="muted">{q.colors.length}</span>
                </button>
              </li>
            ))}
            <li>
              <button onClick={() => store.add([newPalette("New palette")])}>+ New palette</button>
            </li>
            <li>
              <button onClick={() => fileRef.current?.click()} title="Load a .json or .txt palette file">Import…</button>
              <input
                ref={fileRef} type="file" accept=".json,.txt,application/json,text/plain" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const found = importPalettes(await f.text(), f.name.replace(/\.[^.]+$/, ""));
                  if (found.length) { store.add(found); setError(null); }
                  else setError("No colors found in that file. Use one hex code per line, or our JSON format.");
                }}
              />
            </li>
          </ul>

          <div className="palette-edit">
            <label className="stack">
              Name
              <input type="text" aria-label="Palette name" value={p.name}
                onChange={(e) => store.update({ ...p, name: e.target.value })} />
            </label>

            <div className="swatches big" data-testid="palette-colors">
              {p.colors.map((c) => (
                <span key={c} className="chip">
                  <span className="swatch" style={{ background: c }} />
                  <code>{c}</code>
                  <button className="link" aria-label={"Remove " + c} title="Remove this color"
                    onClick={() => store.update({ ...p, colors: p.colors.filter((x) => x !== c) })}>×</button>
                </span>
              ))}
              {p.colors.length === 0 && <span className="muted">No colors yet. Add some below.</span>}
            </div>

            <div className="color-row">
              <input type="text" className="hex" aria-label="New color hex code" value={hex} maxLength={7} spellCheck={false}
                onChange={(e) => setHex(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addColor(hex)} />
              <button onClick={() => addColor(hex)}>Add</button>
              <button onClick={() => onPick((c) => addColor(c))} title="Pick a color by clicking on the picture">Eyedropper</button>
              <button
                disabled={!resultColors.length}
                title="Add every color of the current result"
                onClick={() => store.update({ ...p, colors: [...new Set([...p.colors, ...resultColors])] })}
              >
                Add result colors
              </button>
            </div>
            {error && <p className="fine error-text" role="alert">{error}</p>}

            <div className="color-row">
              <button onClick={() => downloadText(fileName + ".json", paletteToJson(p), "application/json")}>Export JSON</button>
              <button onClick={() => downloadText(fileName + ".txt", paletteToText(p), "text/plain")}>Export text</button>
              <span className="spacer" />
              <button className="danger" title="Delete this palette"
                onClick={() => window.confirm(`Delete the palette "${p.name}"?`) && store.remove(p.id)}>
                Delete palette
              </button>
            </div>
            <p className="fine">Palettes are saved in this browser. Export one to share it or move it to another computer.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
