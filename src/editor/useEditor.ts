// The editable drawing: a list of shapes plus undo/redo history, the current
// selection, and every editing action the Edit panel and canvas can perform.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { TraceResult } from "../pipeline/types";
import type { TextObj } from "../text/layout";
import {
  bounds, parseTranslate, pathItem, rotateAbout, scaleAbout, simplifyPath,
  smoothPath, transformPath, unionBox, unitePaths, type Box, type Matrix,
} from "./geom";
import {
  absorb, bestNeighbor, breakApart as splitPieces, fillHoles, knife as knifeCut, piecesOf,
  removeNodes, smoothNodes, type Pt,
} from "./pathops";

/** Tools that draw a line or region on the picture. */
export type RegionTool = "box" | "lasso" | "knifeLine" | "knifeLasso";

/** One shape of the drawing. Array order is stacking order (last = on top). */
export interface DocShape {
  id: number;
  d: string;
  fill: string;
  /** A label for special shapes, e.g. "Border ring". */
  name?: string;
}

let nextId = 1;
export const newId = () => nextId++;

/** Everything that can be edited and undone. */
export interface Doc {
  shapes: DocShape[];
  texts: TextObj[];
}
const EMPTY: Doc = { shapes: [], texts: [] };

// ---------------------------------------------------------------- history
interface History {
  past: Doc[];
  present: Doc;
  future: Doc[];
  /** State before the current live preview (slider drag, mouse drag), if any. */
  base: Doc | null;
}
type Action =
  | { type: "reset"; doc: Doc }
  | { type: "set"; doc: Doc }
  | { type: "preview"; doc: Doc }
  | { type: "commit" }
  | { type: "undo" }
  | { type: "redo" };

const LIMIT = 100;
/** Turn a finished live preview into one undo step. */
function commit(h: History): History {
  if (!h.base) return h;
  return { past: [...h.past, h.base].slice(-LIMIT), present: h.present, future: [], base: null };
}
function reduce(h0: History, a: Action): History {
  switch (a.type) {
    case "reset":
      return { past: [], present: a.doc, future: [], base: null };
    case "preview":
      return { ...h0, base: h0.base ?? h0.present, present: a.doc };
    case "commit":
      return commit(h0);
    case "set": {
      const h = commit(h0);
      return { past: [...h.past, h.present].slice(-LIMIT), present: a.doc, future: [], base: null };
    }
    case "undo": {
      const h = commit(h0);
      if (!h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], base: null };
    }
    case "redo": {
      const h = commit(h0);
      if (!h.future.length) return h;
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), base: null };
    }
  }
}

export interface ColorGroup {
  fill: string;
  ids: number[];
}

export type Editor = ReturnType<typeof useEditor>;

export function useEditor(result: TraceResult | null) {
  const [h, dispatch] = useReducer(reduce, { past: [], present: EMPTY, future: [], base: null });
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [textId, setTextId] = useState<number | null>(null);
  /** Active "draw on the picture" tool (Replace lettering or Knife), if any. */
  const [regionTool, setRegionTool] = useState<RegionTool | null>(null);
  const [nodeEdit, setNodeEdit] = useState(false);
  /** Selected points while editing nodes, as "loop:index" keys. */
  const [nodeSel, setNodeSel] = useState<ReadonlySet<string>>(new Set());
  /** Point selection to apply when a live "smooth points" preview is committed. */
  const pendingNodeSel = useRef<Set<string> | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const shapes = h.present.shapes;
  const texts = h.present.texts;
  const edited = h.past.length > 0 || h.base !== null;
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const textsRef = useRef(texts);
  textsRef.current = texts;
  /** True after a project was loaded, until the trace of its image arrives (which we then ignore). */
  const loaded = useRef(false);

  // A new trace arrived: it becomes the drawing. If the user had already
  // edited shapes, this is recorded as an undo step so nothing is lost.
  useEffect(() => {
    if (loaded.current) {
      // A project was just opened: keep its saved drawing instead of the fresh trace.
      if (result) loaded.current = false;
      return;
    }
    if (!result) {
      dispatch({ type: "reset", doc: EMPTY });
      setSelection(new Set());
      setTextId(null);
      return;
    }
    const fresh = result.shapes.map((s) => {
      const m = parseTranslate(s.transform);
      return { id: newId(), d: m ? transformPath(s.d, m) : s.d, fill: s.fill, ...(s.name ? { name: s.name } : {}) };
    });
    setSize({ width: result.width, height: result.height });
    // Text objects are kept: they sit on top and do not depend on the trace.
    dispatch({ type: editedRef.current ? "set" : "reset", doc: { shapes: fresh, texts: textsRef.current } });
    setSelection(new Set());
    setNodeEdit(false);
  }, [result]);

  // Drop selected ids that no longer exist (after undo, delete, merge...).
  useEffect(() => {
    setSelection((sel) => {
      if (!sel.size) return sel;
      const alive = new Set(shapes.map((s) => s.id));
      const kept = [...sel].filter((id) => alive.has(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [shapes]);

  // A different shape, or leaving node editing, clears the point selection.
  useEffect(() => setNodeSel(new Set()), [selection, nodeEdit]);

  const selected = useMemo(() => shapes.filter((s) => selection.has(s.id)), [shapes, selection]);
  const selectionBox: Box | null = useMemo(() => unionBox(selected.map((s) => bounds(s.d))), [selected]);

  /** Colours in use, biggest groups first. */
  const groups: ColorGroup[] = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const s of shapes) (map.get(s.fill) ?? map.set(s.fill, []).get(s.fill)!).push(s.id);
    return [...map].map(([fill, ids]) => ({ fill, ids })).sort((a, b) => b.ids.length - a.ids.length);
  }, [shapes]);

  const setDoc = useCallback((doc: Doc) => dispatch({ type: "set", doc }), []);
  /** Replace everything with a drawing from a project file (clears undo history). */
  const loadDoc = useCallback((doc: { shapes: { d: string; fill: string; name?: string }[]; texts: TextObj[] }, docSize: { width: number; height: number }) => {
    loaded.current = true;
    setSize(docSize);
    setSelection(new Set());
    setTextId(null);
    setNodeEdit(false);
    dispatch({
      type: "reset",
      doc: { shapes: doc.shapes.map((s) => ({ ...s, id: newId() })), texts: doc.texts.map((t) => ({ ...t, id: newId() })) },
    });
  }, []);
  const set = (next: DocShape[]) => dispatch({ type: "set", doc: { shapes: next, texts } });
  const preview = (next: DocShape[]) => dispatch({ type: "preview", doc: { shapes: next, texts } });
  const commitPreview = useCallback(() => dispatch({ type: "commit" }), []);
  const selectedText = texts.find((t) => t.id === textId) ?? null;

  /** Replace the selected shapes using `fn`; live = preview without an undo step yet. */
  const mapSelected = (fn: (s: DocShape) => DocShape, live = false, from: DocShape[] = shapes) => {
    const next = from.map((s) => (selection.has(s.id) ? fn(s) : s));
    (live ? preview : set)(next);
  };

  // While a slider is being dragged, changes are computed from the shapes as
  // they were when the drag began (otherwise each step would compound).
  const liveBase = h.base?.shapes ?? shapes;

  const actions = {
    select(ids: Iterable<number>, add = false) {
      setTextId(null);
      setSelection((sel) => {
        if (!add) return new Set(ids);
        const next = new Set(sel);
        for (const id of ids) next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    },
    clearSelection() {
      setSelection(new Set());
      setTextId(null);
      setNodeEdit(false);
    },

    // ---- text objects
    selectText(id: number | null) {
      setSelection(new Set());
      setNodeEdit(false);
      setTextId(id);
    },
    addText(t: TextObj) {
      dispatch({ type: "set", doc: { shapes, texts: [...texts, t] } });
      setSelection(new Set());
      setTextId(t.id);
    },
    /** Change the selected text. live = preview (slider being dragged, typing). */
    updateText(id: number, patch: Partial<TextObj>, live = false) {
      const next = texts.map((t) => (t.id === id ? { ...t, ...patch } : t));
      dispatch({ type: live ? "preview" : "set", doc: { shapes, texts: next } });
    },
    removeText(id: number) {
      dispatch({ type: "set", doc: { shapes, texts: texts.filter((t) => t.id !== id) } });
      setTextId(null);
    },
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),

    /** Give the listed shapes a new colour (used for "recolor this whole group"). */
    fillIds(ids: ReadonlySet<number>, fill: string, live = false) {
      (live ? preview : set)(shapes.map((s) => (ids.has(s.id) ? { ...s, fill } : s)));
    },
    /** Finish a live preview (slider or colour drag) as one undo step. */
    endLive() {
      commitPreview();
      if (pendingNodeSel.current) {
        setNodeSel(pendingNodeSel.current);
        pendingNodeSel.current = null;
      }
    },
    setFill(fill: string, live = false) {
      mapSelected((s) => ({ ...s, fill }), live);
    },
    transform(m: Matrix) {
      mapSelected((s) => ({ ...s, d: transformPath(s.d, m) }));
    },
    flip(horizontal: boolean) {
      if (!selectionBox) return;
      const b = selectionBox;
      actions.transform(horizontal
        ? scaleAbout(-1, 1, b.x + b.w / 2, 0)
        : scaleAbout(1, -1, 0, b.y + b.h / 2));
    },
    rotate(deg: number) {
      if (!selectionBox) return;
      const b = selectionBox;
      actions.transform(rotateAbout(deg, b.x + b.w / 2, b.y + b.h / 2));
    },
    scale(factor: number) {
      if (!selectionBox || factor <= 0) return;
      const b = selectionBox;
      actions.transform(scaleAbout(factor, factor, b.x + b.w / 2, b.y + b.h / 2));
    },
    nudge(dx: number, dy: number) {
      if (selectedText) actions.updateText(selectedText.id, { x: selectedText.x + dx, y: selectedText.y + dy });
      else if (selection.size) actions.transform([1, 0, 0, 1, dx, dy]);
    },
    remove() {
      if (selectedText) actions.removeText(selectedText.id);
      else if (selection.size) set(shapes.filter((s) => !selection.has(s.id)));
    },
    /** Move the selection one step up/down the stack, or all the way. */
    reorder(how: "forward" | "backward" | "front" | "back") {
      if (!selection.size) return;
      const arr = shapes.slice();
      const isSel = (s: DocShape) => selection.has(s.id);
      if (how === "front") return set([...arr.filter((s) => !isSel(s)), ...arr.filter(isSel)]);
      if (how === "back") return set([...arr.filter(isSel), ...arr.filter((s) => !isSel(s))]);
      if (how === "forward") {
        for (let i = arr.length - 2; i >= 0; i--)
          if (isSel(arr[i]) && !isSel(arr[i + 1])) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      } else {
        for (let i = 1; i < arr.length; i++)
          if (isSel(arr[i]) && !isSel(arr[i - 1])) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
      }
      set(arr);
    },
    /** Live while the slider moves; call endLive() when it is released. */
    simplify(tolerance: number) {
      mapSelected((s) => ({ ...s, d: simplifyPath(s.d, tolerance) }), true, liveBase);
    },
    smooth() {
      mapSelected((s) => ({ ...s, d: smoothPath(s.d) }));
    },
    /** Union of all selected shapes; the result keeps the top shape's colour and place. */
    mergeSelected(): string | null {
      if (selected.length < 2) return "Select two or more shapes to merge.";
      let d: string | null = selected[0].d;
      for (let i = 1; i < selected.length && d; i++) d = unitePaths(d, selected[i].d);
      if (!d) return "These shapes could not be merged.";
      const top = selected[selected.length - 1];
      const merged = { id: newId(), d, fill: top.fill };
      set(shapes.flatMap((s) => (s.id === top.id ? [merged] : selection.has(s.id) ? [] : [s])));
      setSelection(new Set([merged.id]));
      return null;
    },
    /** Merge each selected shape into the neighbouring shape it touches most. */
    mergeIntoNeighbor(): string | null {
      const idx = new Set(shapes.flatMap((s, i) => (selection.has(s.id) ? [i] : [])));
      const items = shapes.map((s) => (selection.has(s.id) ? null : pathItem(s.d)));
      // Shapes with no neighbour at all would just disappear, so leave those alone.
      const lonely = [...idx].filter((i) => bestNeighbor(pathItem(shapes[i].d), items) < 0);
      for (const i of lonely) idx.delete(i);
      if (!idx.size) return "No neighbouring shape to merge into.";
      set(absorb(shapes, idx));
      return null;
    },
    /** Split each selected shape into its separate pieces (holes stay with their piece). */
    breakApart(): string | null {
      let pieces = 0;
      const newSel: number[] = [];
      const next = shapes.flatMap((s) => {
        if (!selection.has(s.id)) return [s];
        const parts = splitPieces(s.d);
        if (parts.length < 2) {
          newSel.push(s.id);
          return [s];
        }
        pieces += parts.length;
        return parts.map((d) => {
          const id = newId();
          newSel.push(id);
          return { ...s, id, d };
        });
      });
      if (!pieces) return "The selection is already in one piece.";
      set(next);
      setSelection(new Set(newSel));
      return `Split into ${pieces} pieces.`;
    },
    /** Cut the selected shape(s) in two along a drawn line or lasso. */
    knife(pts: Pt[], mode: "line" | "lasso"): string {
      if (!selected.length) return "Select the shape to cut first, then draw the cut.";
      let cuts = 0;
      const newSel: number[] = [];
      const next = shapes.flatMap((s) => {
        if (!selection.has(s.id)) return [s];
        const r = knifeCut(s.d, pts, mode);
        if (!r) return [s];
        cuts++;
        const a = { ...s, id: newId(), d: r[0] }, b = { ...s, id: newId(), d: r[1] };
        newSel.push(a.id, b.id);
        return [a, b];
      });
      if (!cuts) return `The ${mode === "line" ? "line" : "lasso"} did not cut through the selected shape.`;
      set(next);
      setSelection(new Set(newSel));
      return `Cut ${cuts} ${cuts === 1 ? "shape" : "shapes"} in two.`;
    },
    /** Node editing: delete the selected points. */
    removeSelectedNodes() {
      const sh = selected[0];
      if (!sh || !nodeSel.size) return;
      const d = removeNodes(sh.d, nodeSel);
      set(d ? shapes.map((x) => (x.id === sh.id ? { ...x, d } : x)) : shapes.filter((x) => x.id !== sh.id));
      setNodeSel(new Set());
    },
    /** Node editing: smooth only the selected points (live; endLive() commits). */
    smoothSelectedNodes(tolerance: number) {
      const sh = selected[0];
      const base = sh && liveBase.find((x) => x.id === sh.id);
      if (!base || !nodeSel.size) return;
      const r = smoothNodes(base.d, nodeSel, tolerance);
      pendingNodeSel.current = r.keys;
      preview(liveBase.map((x) => (x.id === sh.id ? { ...x, d: r.d } : x)));
    },
    /**
     * Clean up small defects without leaving gaps: pinholes (small holes) are
     * filled, and specks and slivers (small or thin pieces) are merged into
     * the neighbouring shape that surrounds them. `sizePx` is in drawing
     * units. Returns how many defects were fixed.
     */
    cleanDefects(sizePx: number): number {
      const minArea = sizePx * sizePx;
      let fixed = 0;
      const entries: DocShape[] = [];
      const remove = new Set<number>();
      for (const s of shapes) {
        const d = fillHoles(s.d, minArea);
        if (d !== s.d) fixed += (s.d.match(/M/gi) ?? []).length - (d.match(/M/gi) ?? []).length;
        const ps = piecesOf(pathItem(d));
        const tiny = (p: { area: number; length: number }) => p.area < minArea || (2 * p.area) / Math.max(1, p.length) < sizePx / 4;
        const good = ps.filter((p) => !tiny(p));
        if (good.length === ps.length) {
          entries.push(d === s.d ? s : { ...s, d });
          continue;
        }
        if (good.length) entries.push({ ...s, d: good.map((p) => p.d).join("") });
        for (const p of ps.filter(tiny)) {
          remove.add(entries.length);
          entries.push({ ...s, id: -1, d: p.d });
        }
      }
      fixed += remove.size;
      if (fixed) set(absorb(entries, remove));
      return fixed;
    },
  };

  return {
    shapes, texts, size, selection, selected, selectionBox, groups, edited,
    selectedText, regionTool, setRegionTool, setDoc, loadDoc,
    canUndo: h.past.length > 0 || h.base !== null, canRedo: h.future.length > 0,
    nodeEdit, setNodeEdit, nodeSel, setNodeSel, set, preview, commitPreview,
    ...actions,
  };
}
