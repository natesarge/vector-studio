// Page-side helper: owns the worker, sends it the image and settings, and
// reports progress/results back to React. Settings changes are debounced so
// dragging a slider does not start a job for every pixel of movement.
import { useEffect, useRef, useState } from "react";
import type { SourceImage } from "../lib/loadImage";
import type { CleanupSettings, TraceResult, WorkerRequest, WorkerResponse } from "./types";

export interface VectorizerState {
  result: TraceResult | null;
  busy: boolean;
  stage: string;
  fraction: number;
  error: string | null;
}

const IDLE: VectorizerState = { result: null, busy: false, stage: "", fraction: 0, error: null };

export function useVectorizer(image: SourceImage | null, settings: CleanupSettings | null): VectorizerState {
  const [state, setState] = useState<VectorizerState>(IDLE);
  const workerRef = useRef<Worker | null>(null);
  const runId = useRef(0);
  const sentImage = useRef<SourceImage | null>(null);

  // Create the worker once.
  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.id !== runId.current) return; // an older job; ignore
      if (m.type === "progress") setState((s) => ({ ...s, busy: true, stage: m.stage, fraction: m.fraction }));
      else if (m.type === "done") setState({ result: m.result, busy: false, stage: "", fraction: 1, error: null });
      else setState((s) => ({ ...s, busy: false, error: m.message }));
    };
    worker.onerror = (e) => setState((s) => ({ ...s, busy: false, error: e.message || "The worker crashed." }));
    return () => {
      worker.terminate();
      workerRef.current = null;
      sentImage.current = null;
    };
  }, []);

  useEffect(() => {
    if (!image || !settings) {
      setState(IDLE);
      return;
    }
    const isNewImage = sentImage.current !== image;
    if (isNewImage) setState({ ...IDLE, busy: true, stage: "Starting" });
    let cancelled = false;
    const timer = setTimeout(async () => {
      const worker = workerRef.current;
      if (!worker) return;
      if (sentImage.current !== image) {
        // The worker needs its own copy of the pixels (ours stays on screen).
        const copy = await createImageBitmap(image.bitmap);
        if (cancelled) return copy.close();
        worker.postMessage({ type: "image", bitmap: copy } satisfies WorkerRequest, [copy]);
        sentImage.current = image;
      }
      const id = ++runId.current;
      worker.postMessage({ type: "run", id, settings } satisfies WorkerRequest);
      setState((s) => ({ ...s, busy: true, error: null }));
    }, isNewImage ? 0 : 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [image, settings]);

  return state;
}
