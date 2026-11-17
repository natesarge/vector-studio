import { useRef } from "react";

interface Props {
  fileLabel: string | null;
  checkerboard: boolean;
  onToggleCheckerboard: () => void;
  onOpenFile: (file: File) => void;
}

/** The strip across the top: app name, Open button, and view toggles. */
export default function TopBar({ fileLabel, checkerboard, onToggleCheckerboard, onOpenFile }: Props) {
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
          if (f) onOpenFile(f);
          e.target.value = ""; // allow re-opening the same file
        }}
      />

      {fileLabel && <span className="file-label">{fileLabel}</span>}

      <div className="spacer" />

      <label className="toggle" title="Show a checkerboard behind transparent areas">
        <input type="checkbox" checked={checkerboard} onChange={onToggleCheckerboard} />
        Checkerboard
      </label>
    </header>
  );
}
