import { useRef, useState, type ReactNode } from "react";
import { newId, type Editor } from "../editor/useEditor";
import type { TextObj } from "../text/layout";
import { addUploadedFont, useFonts } from "../text/fonts";
import ColorPicker from "./ColorPicker";
import { Slider } from "./CleanupPanel";

interface Props {
  ed: Editor;
  tabs: ReactNode;
  palette: string[];
  onPick: (use: (hex: string) => void) => void;
  onAddText: () => void;
  onGoogleFonts: () => void;
  /** Message from the last Replace lettering attempt, if any. */
  note: string | null;
}

/** Right panel, Text tab: add text, replace traced lettering, style the selected text. */
export default function TextPanel({ ed, tabs, palette, onPick, onAddText, onGoogleFonts, note }: Props) {
  const fonts = useFonts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fontError, setFontError] = useState<string | null>(null);
  const t = ed.selectedText;

  // Sliders preview live and become one undo step when released.
  const live = (patch: Partial<TextObj>) => t && ed.updateText(t.id, patch, true);
  const set = (patch: Partial<TextObj>) => t && ed.updateText(t.id, patch);
  const slider = (label: string, hint: string, key: keyof TextObj, min: number, max: number, step = 1, extra?: Partial<TextObj>) =>
    t && (
      <Slider
        label={label} hint={hint} min={min} max={max} step={step}
        value={Math.round((t[key] as number) * 100) / 100}
        onChange={(v) => live({ [key]: v, ...extra })}
        onCommit={ed.endLive}
      />
    );

  return (
    <aside className="panel right" aria-label="Text">
      <div className="panel-head">{tabs}</div>

      <div className="panel-body">
        <section>
          <button className="primary wide first" onClick={onAddText} title="Add a new text object in the middle of the picture">
            Add text
          </button>
          <h4>Replace lettering</h4>
          <p className="fine top">
            Draw around one line of traced lettering. It is erased and replaced by real, editable text that matches
            its position, size and slope or arc.
          </p>
          <div className="btn-grid">
            <button
              className={ed.regionTool === "box" ? "on" : ""} aria-pressed={ed.regionTool === "box"}
              onClick={() => ed.setRegionTool(ed.regionTool === "box" ? null : "box")}
              title="Drag a rectangle around the lettering"
            >
              Draw box
            </button>
            <button
              className={ed.regionTool === "lasso" ? "on" : ""} aria-pressed={ed.regionTool === "lasso"}
              onClick={() => ed.setRegionTool(ed.regionTool === "lasso" ? null : "lasso")}
              title="Draw a freehand loop around the lettering (best for curved text)"
            >
              Draw lasso
            </button>
          </div>
          {note && <p className="fine" role="status" data-testid="text-note">{note}</p>}
        </section>

        {ed.texts.length > 0 && (
          <section>
            <h3>Text objects</h3>
            <ul className="shape-list flat" data-testid="text-list">
              {ed.texts.map((x) => (
                <li key={x.id}>
                  <button className={t?.id === x.id ? "on" : ""} onClick={() => ed.selectText(x.id)}>
                    <span className="swatch small" style={{ background: x.fill }} />
                    <span className="grow">{x.text.replace(/\n/g, " / ") || "(empty)"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {t && (
          <>
            <section>
              <h3>Text</h3>
              <textarea
                aria-label="Text content" rows={2} value={t.text} spellCheck={false}
                onChange={(e) => live({ text: e.target.value })}
                onBlur={ed.endLive}
              />
              <h4>Font</h4>
              <select aria-label="Font" value={t.fontId} onChange={(e) => set({ fontId: e.target.value })}>
                {!fonts.some((f) => f.id === t.fontId) && <option value={t.fontId}>(loading…)</option>}
                {fonts.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <div className="btn-grid gap-top">
                <button onClick={() => fileRef.current?.click()} title="Use a .ttf, .otf or .woff font file from your computer">
                  Upload font…
                </button>
                <button onClick={onGoogleFonts} title="Search the open Google Fonts collection and download a font">
                  Google Fonts…
                </button>
              </div>
              <input
                ref={fileRef} type="file" accept=".ttf,.otf,.woff" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    const entry = await addUploadedFont(f);
                    setFontError(null);
                    set({ fontId: entry.id });
                  } catch (err) {
                    setFontError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
              {fontError && <p className="fine error-text" role="alert">{fontError}</p>}

              <h4>Color</h4>
              <ColorPicker
                label="Text" value={t.fill} palette={palette}
                onChange={(hex) => set({ fill: hex })}
                onPreview={(hex) => live({ fill: hex })}
                onPreviewEnd={ed.endLive}
                onPick={() => onPick((hex) => set({ fill: hex }))}
              />
            </section>

            <section>
              <h3>Size and spacing</h3>
              {t.fitWidth !== null && (
                <label className="check" title="The size follows the width of the lettering it replaced. Untick to set the size yourself.">
                  <input type="checkbox" checked onChange={() => set({ fitWidth: null })} />
                  Auto-fit width ({Math.round(t.fitWidth)})
                </label>
              )}
              {t.fitWidth === null
                ? slider("Size", "Height of the letters", "size", 8, Math.round(ed.size.width / 2))
                : slider("Fit width", "Total width the text is stretched to", "fitWidth", 20, ed.size.width)}
              {slider("Letter spacing", "Extra space between letters (negative = tighter)", "spacing", -0.3, 1.5, 0.01)}
              {slider("Line height", "Distance between lines of text", "lineHeight", 0.6, 2.5, 0.05)}
            </section>

            <section>
              <h3>Angle</h3>
              {slider("Rotation", "Turn the whole text", "rotation", -180, 180)}
              {slider("Slant", "Lean the letters, like italics", "slant", -45, 45)}
              {slider("Baseline slope", "Tilt the line the letters stand on while keeping them upright", "slope", -30, 30, 0.5)}
            </section>

            <section>
              <h3>Curve</h3>
              <div className="segmented fill" role="radiogroup" aria-label="Curve type">
                {(["none", "bend", "circle"] as const).map((c) => (
                  <button key={c} role="radio" aria-checked={t.curve === c} className={t.curve === c ? "on" : ""} onClick={() => set({ curve: c })}>
                    {c === "none" ? "Straight" : c === "bend" ? "Bend" : "Circle"}
                  </button>
                ))}
              </div>
              {t.curve === "bend" && slider("Bend", "Positive arches up, negative arches down. 100 wraps into a full circle.", "bend", -100, 100)}
              {t.curve === "circle" && (
                <>
                  {slider("Radius", "Radius of the circle the text follows", "radius", 20, ed.size.width * 1.5)}
                  <label className="check" title="Put the text along the bottom of the circle instead of the top">
                    <input type="checkbox" checked={t.curveDown} onChange={(e) => set({ curveDown: e.target.checked })} />
                    Along the bottom
                  </label>
                </>
              )}
              {slider("Wave", "Make the letters ride a wave (0 = off)", "wave", 0, 60)}
              {t.wave > 0 && slider("Wave length", "Distance between wave crests", "waveLength", 0.5, 12, 0.1)}
            </section>

            <section>
              <h3>Letter sizes</h3>
              <select aria-label="Letter size variation" value={t.sizeMode} onChange={(e) => set({ sizeMode: e.target.value as TextObj["sizeMode"] })}>
                <option value="none">All the same</option>
                <option value="first">Bigger first letter</option>
                <option value="ends">Bigger first and last letters</option>
                <option value="middle">Bigger in the middle</option>
                <option value="edges">Bigger at the edges</option>
              </select>
              {t.sizeMode !== "none" && slider("Amount", "How much bigger, in percent", "sizeAmount", 0, 100)}
            </section>

            <section>
              <h3>Effects</h3>
              {slider("Outline width", "Stroke around the letters (0 = off)", "strokeWidth", 0, Math.max(10, Math.round(ed.size.width / 40)), 0.5)}
              {t.strokeWidth > 0 && (
                <ColorPicker
                  label="Outline" value={t.strokeColor} palette={palette}
                  onChange={(hex) => set({ strokeColor: hex })}
                  onPreview={(hex) => live({ strokeColor: hex })}
                  onPreviewEnd={ed.endLive}
                  onPick={() => onPick((hex) => set({ strokeColor: hex }))}
                />
              )}
              {slider("3D depth", "Stacked copies in a darker shade behind the letters (0 = off)", "extrude", 0, Math.max(20, Math.round(ed.size.width / 25)))}
              {t.extrude > 0 && slider("3D direction", "Which way the depth points, in degrees", "extrudeAngle", 0, 360, 5)}
              <label className="check" title="A soft copy of the text behind it">
                <input type="checkbox" checked={t.shadow} onChange={(e) => set({ shadow: e.target.checked })} />
                Drop shadow
              </label>
              {t.shadow && (
                <>
                  {slider("Shadow right", "Shadow offset to the right", "shadowX", -60, 60)}
                  {slider("Shadow down", "Shadow offset downward", "shadowY", -60, 60)}
                </>
              )}
            </section>

            <section>
              <div className="btn-grid">
                <button
                  title="Make a copy of this text"
                  onClick={() => ed.addText({ ...t, id: newId(), x: t.x + ed.size.width * 0.03, y: t.y + ed.size.width * 0.03 })}
                >
                  Duplicate
                </button>
                <button className="danger" onClick={() => ed.removeText(t.id)} title="Delete this text (Delete key)">
                  Delete text
                </button>
              </div>
            </section>
          </>
        )}
      </div>

      <div className="panel-foot">
        <span className="muted">
          {ed.regionTool ? "Draw around the lettering on the result · Esc to cancel" : t ? "Drag the text on the picture to move it" : "Text stays editable until you export"}
        </span>
      </div>
    </aside>
  );
}
