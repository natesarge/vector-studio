import { useState } from "react";
import type { Editor } from "../editor/useEditor";
import { shapeSize } from "../editor/EditorLayer";
import ColorPicker from "./ColorPicker";

interface Props {
  ed: Editor;
  palette: string[];
  /** Start eyedropper mode; `use` receives the picked colour. */
  onPick: (use: (hex: string) => void) => void;
}

/** Right panel: colours, the selected shape(s), path tools and defect cleanup. */
export default function EditPanel({ ed, palette, onPick }: Props) {
  // Which colour group has its picker open. Remembered by shape ids, because
  // the group's colour changes while the user is choosing a new one.
  const [recolor, setRecolor] = useState<{ ids: ReadonlySet<number>; anchor: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null); // group whose shape list is expanded
  const [simplify, setSimplify] = useState(0);
  const [angle, setAngle] = useState(15);
  const [percent, setPercent] = useState(110);
  const [defectSize, setDefectSize] = useState(Math.max(4, Math.round(ed.size.width / 250)));
  const [note, setNote] = useState<string | null>(null);

  const n = ed.selected.length;
  const fill = n ? ed.selected[0].fill : "#000000";
  const mixed = n > 1 && ed.selected.some((s) => s.fill !== fill);
  const say = (msg: string | null) => setNote(msg);
  const order = (id: number) => ed.shapes.findIndex((s) => s.id === id) + 1;

  return (
    <aside className="panel right" aria-label="Edit">
      <div className="panel-head">
        <h2>Edit</h2>
      </div>

      <div className="panel-body">
        <section>
          <h3>Colors</h3>
          <p className="fine top">Click a swatch to recolor every shape of that color.</p>
          <ul className="groups" data-testid="color-groups">
            {ed.groups.map((g) => {
              const isOpen = recolor !== null && g.ids.includes(recolor.anchor);
              return (
                <li key={g.fill}>
                  <div className="group-row">
                    <button
                      className="swatch"
                      style={{ background: g.fill }}
                      aria-label={"Recolor " + g.fill}
                      title="Recolor all shapes of this color"
                      onClick={() => setRecolor(isOpen ? null : { ids: new Set(g.ids), anchor: g.ids[0] })}
                    />
                    <button className="group-name" title="Select all shapes of this color" onClick={() => ed.select(g.ids)}>
                      <span>{g.fill}</span>
                      <span className="muted">{g.ids.length} {g.ids.length === 1 ? "shape" : "shapes"}</span>
                    </button>
                    <button
                      className="link caret"
                      aria-label={(open === g.fill ? "Hide" : "Show") + " shapes of " + g.fill}
                      title="Show the individual shapes"
                      onClick={() => setOpen(open === g.fill ? null : g.fill)}
                    >
                      {open === g.fill ? "▾" : "▸"}
                    </button>
                  </div>
                  {isOpen && (
                    <ColorPicker
                      label="Group"
                      value={g.fill}
                      palette={palette}
                      onChange={(hex) => { ed.fillIds(recolor!.ids, hex); }}
                      onPreview={(hex) => ed.fillIds(recolor!.ids, hex, true)}
                      onPreviewEnd={ed.endLive}
                      onPick={() => onPick((hex) => ed.fillIds(recolor!.ids, hex))}
                    />
                  )}
                  {open === g.fill && (
                    <ul className="shape-list">
                      {g.ids.map((id) => {
                        const s = ed.shapes.find((x) => x.id === id)!;
                        return (
                          <li key={id}>
                            <button
                              className={ed.selection.has(id) ? "on" : ""}
                              onClick={(e) => ed.select([id], e.shiftKey)}
                              title="Select this shape (Shift-click to add)"
                            >
                              Shape {order(id)} <span className="muted">{shapeSize(s.d)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3>Selection</h3>
          {n === 0 ? (
            <p className="fine top">
              Click a shape in the result to select it. Shift-click adds more. Drag a selected shape to move it.
            </p>
          ) : (
            <>
              <p className="fine top" data-testid="selection-count">
                {n} {n === 1 ? "shape" : "shapes"} selected{mixed ? " (mixed colors)" : ""}
              </p>

              <h4>Fill</h4>
              <ColorPicker
                label="Fill"
                value={fill}
                palette={palette}
                onChange={(hex) => ed.setFill(hex)}
                onPreview={(hex) => ed.setFill(hex, true)}
                onPreviewEnd={ed.endLive}
                onPick={() => onPick((hex) => ed.setFill(hex))}
              />

              <h4>Arrange</h4>
              <div className="btn-grid">
                <button onClick={() => ed.reorder("front")} title="Put on top of everything">To front</button>
                <button onClick={() => ed.reorder("forward")} title="Move one step up">Forward</button>
                <button onClick={() => ed.reorder("backward")} title="Move one step down">Backward</button>
                <button onClick={() => ed.reorder("back")} title="Put underneath everything">To back</button>
              </div>

              <h4>Transform</h4>
              <div className="btn-grid">
                <button onClick={() => ed.flip(true)} title="Mirror left-right">Flip ↔</button>
                <button onClick={() => ed.flip(false)} title="Mirror top-bottom">Flip ↕</button>
              </div>
              <div className="inline-field">
                <label>
                  Rotate
                  <input type="number" aria-label="Rotation in degrees" value={angle} step={5}
                    onChange={(e) => setAngle(Number(e.target.value))} />°
                </label>
                <button onClick={() => ed.rotate(-angle)} title="Rotate counter-clockwise">↺</button>
                <button onClick={() => ed.rotate(angle)} title="Rotate clockwise">↻</button>
              </div>
              <div className="inline-field">
                <label>
                  Scale
                  <input type="number" aria-label="Scale in percent" value={percent} min={1} step={5}
                    onChange={(e) => setPercent(Number(e.target.value))} />%
                </label>
                <button onClick={() => ed.scale(percent / 100)} title="Resize by this percentage">Apply</button>
              </div>
              <p className="fine">Or drag the box handles on the picture.</p>

              <h4>Path</h4>
              <label className="field" title="Fewer points, simpler outline. Slide right for more.">
                <span className="field-head">
                  <span>Simplify</span>
                  <span className="field-value">{simplify}</span>
                </span>
                <input
                  type="range" aria-label="Simplify" min={0} max={40} step={1} value={simplify}
                  onChange={(e) => { const v = Number(e.target.value); setSimplify(v); ed.simplify(v); }}
                  onPointerUp={() => { ed.endLive(); setSimplify(0); }}
                  onKeyUp={() => { ed.endLive(); setSimplify(0); }}
                />
              </label>
              <div className="btn-grid">
                <button onClick={() => ed.smooth()} title="Turn every point into a smooth curve">Smooth</button>
                <button
                  className={ed.nodeEdit ? "on" : ""}
                  disabled={n !== 1}
                  aria-pressed={ed.nodeEdit}
                  onClick={() => ed.setNodeEdit(!ed.nodeEdit)}
                  title="Drag individual points. Double-click a point to remove it, or the outline to add one."
                >
                  Edit nodes
                </button>
              </div>

              <h4>Merge</h4>
              <div className="btn-grid">
                <button disabled={n < 2} onClick={() => say(ed.mergeSelected())} title="Join the selected shapes into one">
                  Merge selected
                </button>
                <button onClick={() => say(ed.mergeIntoNeighbor())} title="Join into the shape directly underneath">
                  Into neighbor
                </button>
              </div>

              <button className="danger wide" onClick={() => ed.remove()} title="Delete the selected shapes (Delete key)">
                Delete
              </button>
            </>
          )}
        </section>

        <section>
          <h3>Clean defects</h3>
          <label className="field" title="Shapes smaller or thinner than this are removed.">
            <span className="field-head">
              <span>Defect size</span>
              <span className="field-value">{defectSize}</span>
            </span>
            <input type="range" aria-label="Defect size" min={1} max={40} value={defectSize}
              onChange={(e) => setDefectSize(Number(e.target.value))} />
          </label>
          <button
            className="wide"
            title="Removes tiny specks, fills pinholes and merges thin slivers into their surroundings"
            onClick={() => {
              const k = ed.cleanDefects(defectSize);
              say(k ? `Removed ${k} small ${k === 1 ? "defect" : "defects"}.` : "No defects found at this size.");
            }}
          >
            Clean defects
          </button>
        </section>
      </div>

      <div className="panel-foot" data-testid="edit-note">
        <span className="muted">{note ?? `${ed.shapes.length} shapes`}</span>
      </div>
    </aside>
  );
}
