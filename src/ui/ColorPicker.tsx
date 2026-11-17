import { useEffect, useState } from "react";
import { isHex } from "../pipeline/color";

interface Props {
  value: string;
  /** Brand swatches offered as one-click choices. */
  palette: string[];
  /** Final choice (one undo step). */
  onChange: (hex: string) => void;
  /** Called continuously while dragging in the colour dialog. */
  onPreview?: (hex: string) => void;
  /** Called when the colour dialog closes after previews. */
  onPreviewEnd?: () => void;
  /** Start "click the picture to pick a colour". */
  onPick: () => void;
  label: string;
}

/** Colour chooser: colour dialog, hex code box, eyedropper, palette swatches. */
export default function ColorPicker({ value, palette, onChange, onPreview, onPreviewEnd, onPick, label }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const submitText = () => {
    const t = text.trim().startsWith("#") ? text.trim() : "#" + text.trim();
    if (isHex(t) && t.toUpperCase() !== value.toUpperCase()) onChange(t.toUpperCase());
    else setText(value);
  };

  return (
    <div className="color-picker">
      <div className="color-row">
        <input
          type="color"
          aria-label={label + " color dialog"}
          title="Open the color dialog"
          value={isHex(value) ? value : "#000000"}
          onChange={(e) => (onPreview ?? onChange)(e.target.value.toUpperCase())}
          onBlur={() => onPreviewEnd?.()}
        />
        <input
          type="text"
          className="hex"
          aria-label={label + " hex code"}
          title="Type a hex color code such as #EE6A01, then press Enter"
          value={text}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={submitText}
          onKeyDown={(e) => e.key === "Enter" && submitText()}
        />
        <button onClick={onPick} title="Pick a color by clicking on the picture">
          Eyedropper
        </button>
      </div>
      {palette.length > 0 && (
        <div className="swatches">
          {palette.map((c) => (
            <button
              key={c}
              className={"swatch small" + (c === value ? " current" : "")}
              style={{ background: c }}
              title={c}
              aria-label={"Use " + c}
              onClick={() => onChange(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
