import { useEffect, useMemo, useState } from "react";
import { addGoogleFont, loadCatalog, type CatalogFont, type FontEntry } from "../text/fonts";

interface Props {
  onAdded: (font: FontEntry) => void;
  onClose: () => void;
}

/** Closest available weight to bold-ish 700, which suits logo lettering. */
const defaultWeight = (f: CatalogFont) =>
  f.weights.reduce((best, w) => (Math.abs(w - 700) < Math.abs(best - 700) ? w : best), f.weights[0]);

/**
 * Dialog for finding a font in the open Google Fonts collection (served by
 * Fontsource) and downloading it into the app. Only the font's name is sent
 * over the network; nothing about your image leaves the computer.
 */
export default function FontPicker({ onAdded, onClose }: Props) {
  const [catalog, setCatalog] = useState<CatalogFont[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    loadCatalog().then(setCatalog, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const matches = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    const hit = q ? catalog.filter((f) => f.family.toLowerCase().includes(q)) : catalog;
    // Names that start with the search text come first.
    return hit.sort((a, b) => Number(b.family.toLowerCase().startsWith(q)) - Number(a.family.toLowerCase().startsWith(q))).slice(0, 40);
  }, [catalog, query]);

  const add = async (f: CatalogFont) => {
    setBusy(f.id);
    setError(null);
    try {
      onAdded(await addGoogleFont(f, weights[f.id] ?? defaultWeight(f)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-label="Google Fonts" aria-modal="true">
        <div className="modal-head">
          <h2>Google Fonts</h2>
          <button className="link" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="modal-body column">
          <input
            type="text" autoFocus aria-label="Search fonts by name" placeholder="Search by name, e.g. Bebas"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          {error && <p className="fine error-text" role="alert">{error}</p>}
          {!catalog && !error && <p className="fine">Loading the font list…</p>}
          {catalog && (
            <ul className="font-results" data-testid="font-results">
              {matches.map((f) => (
                <li key={f.id}>
                  <span className="grow">
                    {f.family} <span className="muted">· {f.category} · {f.license}</span>
                  </span>
                  {f.weights.length > 1 && (
                    <select
                      aria-label={"Weight for " + f.family} title="Weight (400 = regular, 700 = bold)"
                      value={weights[f.id] ?? defaultWeight(f)}
                      onChange={(e) => setWeights({ ...weights, [f.id]: Number(e.target.value) })}
                    >
                      {f.weights.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  )}
                  <button disabled={busy !== null} onClick={() => add(f)} aria-label={"Add " + f.family}>
                    {busy === f.id ? "Adding…" : "Add"}
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="muted">No font with that name.</li>}
            </ul>
          )}
          <p className="fine">
            Fonts come from the open Google Fonts collection via Fontsource and are downloaded straight into your
            browser. Check a font's license before commercial use.
          </p>
        </div>
      </div>
    </div>
  );
}
