export function initVtracer(wasmUrl: string): Promise<void>;
export function vectorize_bytes(data: Uint8Array, options: unknown): string;
export function vectorize_rgba(data: Uint8Array, width: number, height: number, options: unknown): string;
