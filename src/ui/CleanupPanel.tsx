import type { CleanupSettings, TraceResult } from "../pipeline/types";
import type { Palette } from "../lib/palettes";

interface SliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}

/** A labelled slider with its current value shown on the right. */
function Slider({ label, hint, value, min, max, step = 1, disabled, onChange }: SliderProps) {
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
      />
    </label>
  );
}

interface Props {
  settings: CleanupSettings;
  onChange: (patch: Partial<CleanupSettings>) => void;
  onReset: () => void;
  palette: Palette;
  result: TraceResult | null;
  busy: boolean;
  stage: string;
  fraction: number;
}

/** Left panel: every setting of the clean-up pipeline, with live preview. */
export default function CleanupPanel({ settings: s, onChange, onReset, palette, result, busy, stage, fraction }: Props) {
  return (
    <aside className="panel left" aria-label="Clean up">
      <div className="panel-head">
        <h2>Clean up</h2>
        <button className="link" onClick={onReset} title="Put every setting back to its starting value">
          Reset
        </button>
      </div>

      <div className="panel-body">
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
            Snap to palette: {palette.name}
          </label>
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
