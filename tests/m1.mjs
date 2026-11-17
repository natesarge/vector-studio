// Milestone 1 smoke test: open an image three ways, zoom, pan, take screenshots.
// Run with the dev server up:  node tests/m1.mjs [url]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const imgDir = join(here, "..", "reference", "images");
const images = readdirSync(imgDir).filter((f) => !f.includes("_grid"));
const url = process.argv[2] ?? "http://localhost:5173/";

const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};

// Uses the Edge that ships with Windows, so no browser download is needed.
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url);
await page.screenshot({ path: join(out, "m1-empty.png") });

// 1. Open with the file picker.
const first = join(imgDir, images[0]);
await page.locator('header input[type="file"]').setInputFiles(first);
await page.waitForSelector(".artboard canvas");
const zoom = () => page.getByTestId("zoom-value").innerText();
const fitZoom = await zoom();
assert((await page.locator(".file-label").innerText()).includes(images[0]), "file name shown: " + images[0]);
await page.screenshot({ path: join(out, "m1-opened.png") });

// The canvas must actually contain the picture (not be blank).
const painted = await page.evaluate(() => {
  const c = document.querySelector(".artboard canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4001) { min = Math.min(min, d[i]); max = Math.max(max, d[i]); }
  return max - min;
});
assert(painted > 50, "canvas has image content");

// 2. Wheel zoom keeps the point under the cursor still.
const box = await page.locator(".viewport").boundingBox();
const px = box.x + box.width * 0.6, py = box.y + box.height * 0.4;
const imgPointAt = (x, y) => page.evaluate(([x, y]) => {
  const r = document.querySelector(".artboard").getBoundingClientRect();
  return [(x - r.left) / r.width, (y - r.top) / r.height];
}, [x, y]);
const before = await imgPointAt(px, py);
await page.mouse.move(px, py);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(100);
const after = await imgPointAt(px, py);
assert(await zoom() !== fitZoom, `wheel zoom changed ${fitZoom} -> ${await zoom()}`);
assert(Math.hypot(before[0] - after[0], before[1] - after[1]) < 0.002, "zoom is anchored at the cursor");

// 3. Drag pans by the same distance as the mouse.
const r0 = await page.locator(".artboard").boundingBox();
await page.mouse.down(); await page.mouse.move(px + 120, py + 70, { steps: 5 }); await page.mouse.up();
const r1 = await page.locator(".artboard").boundingBox();
assert(Math.abs(r1.x - r0.x - 120) < 1 && Math.abs(r1.y - r0.y - 70) < 1, "drag pans the image");
await page.screenshot({ path: join(out, "m1-zoomed.png") });

// 4. Buttons.
await page.getByRole("button", { name: "100%" }).click();
assert(await zoom() === "100%", "100% button");
await page.getByRole("button", { name: "Fit" }).click();
assert(await zoom() === fitZoom, "Fit button restores " + fitZoom);

// 5. Drag-and-drop and paste (simulated with real File objects).
const sendFile = async (kind, file) => {
  const b64 = readFileSync(join(imgDir, file)).toString("base64");
  await page.evaluate(async ([kind, name, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const type = name.endsWith(".jpg") ? "image/jpeg" : "image/png";
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    if (kind === "drop") {
      const t = document.querySelector(".app");
      for (const ev of ["dragenter", "dragover", "drop"])
        t.dispatchEvent(new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }, [kind, file, b64]);
  await page.waitForFunction((n) => document.querySelector(".file-label")?.textContent.includes(n), file);
};
await sendFile("drop", images[1]);
assert(true, "drag-and-drop opens " + images[1]);
await sendFile("paste", images[2]);
assert(true, "paste opens " + images[2]);
await page.screenshot({ path: join(out, "m1-pasted.png") });

// 6. Oversized image is scaled down to 4000 px.
await page.evaluate(async () => {
  const c = new OffscreenCanvas(5000, 2500);
  const g = c.getContext("2d"); g.fillStyle = "#1C4062"; g.fillRect(0, 0, 5000, 2500);
  g.fillStyle = "#EE6A01"; g.beginPath(); g.arc(2500, 1250, 900, 0, 7); g.fill();
  const blob = await c.convertToBlob({ type: "image/png" });
  const dt = new DataTransfer(); dt.items.add(new File([blob], "huge.png", { type: "image/png" }));
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
});
await page.waitForFunction(() => document.querySelector(".file-label")?.textContent.includes("huge.png"));
assert((await page.locator(".file-label").innerText()).includes("4000 × 2000"), "5000 px image scaled to 4000 × 2000");

// 7. A non-image shows a friendly error.
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.items.add(new File(["hi"], "notes.txt", { type: "text/plain" }));
  const t = document.querySelector(".app");
  for (const ev of ["dragenter", "drop"]) t.dispatchEvent(new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForSelector(".error-bar");
assert(true, "non-image drop shows an error");
await page.screenshot({ path: join(out, "m1-error.png") });

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM1 smoke test passed. Screenshots in tests/out/");
