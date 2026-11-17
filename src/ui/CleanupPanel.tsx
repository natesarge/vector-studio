import type { CleanupSettings, TraceResult } from "../pipeline/types";
import type { Palettes } from "../lib/palettes";

interface SliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  /** Called when the slider is released (mouse up or key up). */
  onCommit?: () => void;
}

/** A labelled slider with its current value shown on the right. */
export function Slider({ label, hint, value, min, max, step = 1, disabled, onChange, onCommit }: SliderProps) {
  return (
    <label className={"field" + (disabled ? " disabled" : "")} title={hint}>
      <span className="field-head">
        <span>{label}</span>
        <span className="field-value">{value}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
    </label>
  );
}

interface Props {
  settings: CleanupSettings;
  onChange: (patch: Partial<CleanupSettings>) => void;
  onReset: () => void;
  palettes: Palettes;
  onManagePalettes: () => void;
  /** True once shapes have been edited by hand (re-tracing would replace them). */
  edited: boolean;
  result: TraceResult | null;
  busy: boolean;
  stage: string;
  fraction: number;
}

/** Left panel: every setting of the clean-up pipeline, with live preview. */
export default function CleanupPanel({ settings: s, onChange, onReset, palettes, onManagePalettes, edited, result, busy, stage, fraction }: Props) {
  const palette = palettes.active;
  return (
    <aside className="panel left" aria-label="Clean up">
      <div className="panel-head">
        <h2>Clean up</h2>
        <button className="link" onClick={onReset} title="Put every setting back to its starting value">
          Reset
        </button>
      </div>

      <div className="panel-body">
        {edited && (
          <p className="notice" role="note">
            You have edited shapes. Changing a setting here re-traces the image and replaces your edits (Undo
            brings them back).
          </p>
        )}
        <section>
          <h3>Background</h3>
          <label className="check" title="Cut the design out of its background and drop shadow">
            <input
              type="checkbox"
              checked={s.removeBackground}
              onChange={(e) => onChange({ removeBackground: e.target.checked })}
            />
            Remove background
          </label>
          <Slider
            label="Tolerance"
            hint="Higher removes more (follows gradients and shadows further). Lower if parts of the design vanish."
            value={s.bgTolerance}
            min={1}
            max={20}
            disabled={!s.removeBackground}
            onChange={(v) => onChange({ bgTolerance: v })}
          />
        </section>

        <section>
          <h3>Outline and border</h3>
          <label className="stack" title="Replace the wobbly outer outline with a perfect shape when it fits">
            Outline snap
            <select
              aria-label="Outline snap"
              value={s.outlineSnap}
              disabled={!s.removeBackground}
              onChange={(e) => onChange({ outlineSnap: e.target.value as CleanupSettings["outlineSnap"] })}
            >
              <option value="auto">Auto-detect</option>
              <option value="circle">Circle / ellipse</option>
              <option value="rect">Rounded rectangle</option>
              <option value="off">Off (keep traced outline)</option>
            </select>
          </label>
          <label className="check" title="Find the outer border band and redraw it as one clean, solid band">
            <input
              type="checkbox"
              checked={s.border}
              disabled={!s.removeBackground}
              onChange={(e) => onChange({ border: e.target.checked })}
            />
            Redraw outer border
          </label>
          <Slider
            label="Border width adjust"
            hint="Added to the detected border width. Raise it to cover a ragged inner edge; lower it if it eats into the design."
            value={s.borderExtra}
            min={-20}
            max={60}
            disabled={!s.removeBackground || !s.border}
            onChange={(v) => onChange({ borderExtra: v })}
          />
          <div className={"color-row" + (!s.removeBackground || !s.border ? " disabled" : "")}>
            <label className="check inline" title="Untick to choose the border color yourself">
              <input
                type="checkbox"
                checked={s.borderColor === null}
                onChange={(e) => onChange({ borderColor: e.target.checked ? null : "#1C4062" })}
              />
              Border color from image
            </label>
            {s.borderColor !== null && (
              <input
                type="color"
                aria-label="Border color"
                value={s.borderColor}
                onChange={(e) => onChange({ borderColor: e.target.value.toUpperCase() })}
              />
            )}
          </div>
          {result?.outline && (
            <p className="fine" data-testid="outline-info">
              Outline: {result.outline}
              {result.borderWidth ? ` · border ${result.borderWidth} px` : ""}
            </p>
          )}
        </section>

        <section>
          <h3>Colors</h3>
          <Slider
            label="Smoothing"
            hint="Removes texture such as stitching, fabric and noise. Higher is smoother but loses small details."
            value={s.smooth}
            min={0}
            max={20}
            step={0.5}
            onChange={(v) => onChange({ smooth: v })}
          />
          <Slider
            label="Number of colors"
            hint="Count the colors in your design and add one for the background."
            value={s.colors}
            min={2}
            max={16}
            onChange={(v) => onChange({ colors: v })}
          />
          <Slider
            label="Merge similar shades"
            hint="Shades closer than this are treated as one color. Raise it to merge more."
            value={s.merge}
            min={0}
            max={40}
            onChange={(v) => onChange({ merge: v })}
          />
          <label className="check" title="Replace every color with the nearest color of the palette">
            <input
              type="checkbox"
              checked={s.paletteSnap}
              onChange={(e) => onChange({ paletteSnap: e.target.checked })}
            />
            Snap to palette
          </label>
          <div className="color-row">
            <select
              aria-label="Palette"
              title="Which palette to snap to (also used for the swatch buttons in the Edit panel)"
              value={palette.id}
              onChange={(e) => palettes.setActive(e.target.value)}
            >
              {palettes.palettes.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button onClick={onManagePalettes} title="Create, edit, import and export palettes">Manage…</button>
          </div>
          <div className="swatches" aria-label={palette.name + " palette"}>
            {palette.colors.map((c) => (
              <span key={c} className="swatch small" style={{ background: c }} title={c} />
            ))}
          </div>
        </section>

        <section>
          <h3>Tracing</h3>
          <Slider
            label="Speckle removal"
            hint="Shapes smaller than about this many pixels across are dropped."
            value={s.speckle}
            min={0}
            max={120}
            onChange={(v) => onChange({ speckle: v })}
          />
          <Slider
            label="Corner sharpness"
            hint="Higher keeps more sharp corners. Lower rounds them off."
            value={s.cornerSharpness}
            min={0}
            max={100}
            step={5}
            onChange={(v) => onChange({ cornerSharpness: v })}
          />
          <Slider
            label="Curve smoothness"
            hint="Higher gives longer, smoother curves with fewer points."
            value={s.curveSmoothness}
            min={0}
            max={100}
            step={5}
            onChange={(v) => onChange({ curveSmoothness: v })}
          />
        </section>

        {result && (
          <section>
            <h3>Result</h3>
            <div className="swatches" data-testid="result-colors">
              {result.colors.map((c) => (
                <span key={c} className="swatch" style={{ background: c }} title={c} />
              ))}
            </div>
            <p className="fine">
              {result.shapes.length} shapes · {result.colors.length} colors · {(result.ms / 1000).toFixed(1)} s
            </p>
          </section>
        )}
      </div>

      <div className="panel-foot" data-status={busy ? "busy" : result ? "done" : "idle"} data-testid="status">
        {busy ? (
          <>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.max(3, fraction * 100)}%` }} />
            </div>
            <span>{stage || "Working"}…</span>
          </>
        ) : (
          <span className="muted">{result ? "Up to date" : "Waiting for an image"}</span>
        )}
      </div>
    </aside>
  );
}
