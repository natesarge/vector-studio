// Milestone 2 test: run every reference image through the pipeline in a real
// browser, save the exported SVG, and build comparison sheets against the
// Python reference output (if tests/out/python-m2/*.svg exist).
// Run with the dev server up:  node tests/m2.mjs [url] [only-this-image]
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const imgDir = join(here, "..", "reference", "images");
const url = process.argv[2] ?? "http://localhost:5173/";
const only = process.argv[3];
const images = readdirSync(imgDir).filter((f) => !f.includes("_grid") && (!only || f.startsWith(only)));

const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);

const done = () => page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 180000 });
const busy = () => page.waitForSelector('[data-testid="status"][data-status="busy"]', { timeout: 10000 });

for (const file of images) {
  const name = file.replace(/\.[^.]+$/, "");
  await page.locator('header input[type="file"]').setInputFiles(join(imgDir, file));
  await page.waitForFunction((n) => document.querySelector(".file-label")?.textContent.includes(n), file);
  // Match the Python defaults: snap colours to the brand palette.
  const snap = page.getByLabel(/Snap to palette/);
  if (!(await snap.isChecked())) await snap.check();
  const t0 = Date.now();
  await busy().catch(() => {});
  await done();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await page.locator(".panel .fine").last().innerText();
  console.log(`\n== ${file}: ${secs}s wall, ${info}`);
  await page.screenshot({ path: join(out, `m2-${name}-side.png`) });

  // Export through the real button and keep the file.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export SVG" }).click()]);
  const svgPath = join(out, `m2-${name}.svg`);
  await download.saveAs(svgPath);
  const svg = readFileSync(svgPath, "utf8");
  assert(download.suggestedFilename() === name + ".svg", "export file name " + download.suggestedFilename());
  assert(svg.startsWith("<?xml") && (svg.match(/<path /g) ?? []).length > 3, "exported SVG has shapes");
  const colors = await page.locator('[data-testid="result-colors"] .swatch').evaluateAll((els) => els.map((e) => e.title));
  console.log("   colors: " + colors.join(" "));

  // Comparison sheet: original | Python | ours, on a checkerboard.
  const pyPath = join(out, "python-m2", name + ".svg");
  const uri = (p, mime) => `data:${mime};base64,` + readFileSync(p).toString("base64");
  const cells = [
    ["Original", uri(join(imgDir, file), file.endsWith(".jpg") ? "image/jpeg" : "image/png")],
    ...(existsSync(pyPath) ? [["Python reference", uri(pyPath, "image/svg+xml")]] : []),
    ["Browser (this app)", uri(svgPath, "image/svg+xml")],
  ];
  const sheet = await browser.newPage({ viewport: { width: 560 * cells.length, height: 600 } });
  await sheet.setContent(
    `<body style="margin:0;display:flex;font:14px sans-serif;background:#888">` +
      cells.map(([label, src]) =>
        `<div style="flex:1;text-align:center;padding:6px"><div style="color:#fff;padding:4px">${label}</div>` +
        `<img src="${src}" style="width:540px;height:540px;object-fit:contain;background:repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/24px 24px"></div>`).join("") +
      `</body>`);
  await sheet.waitForTimeout(400);
  await sheet.screenshot({ path: join(out, `m2-${name}-compare.png`) });
  // Zoomed crops (centre and lower third) to judge edge quality.
  for (const [tag, ox, oy] of [["a", 50, 45], ["b", 50, 78]]) {
    await sheet.setContent(
      `<body style="margin:0;display:flex;background:#888">` +
        cells.map(([, src]) =>
          `<div style="flex:1;height:600px;margin:3px;background:url('${src}') ${ox}% ${oy}%/1900px auto no-repeat, repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/24px 24px"></div>`).join("") +
        `</body>`);
    await sheet.waitForTimeout(400);
    await sheet.screenshot({ path: join(out, `m2-${name}-zoom-${tag}.png`) });
  }
  await sheet.close();
}

// View modes, outlines, slider drag, and that changing a setting re-runs the job.
for (const label of ["Original", "Result", "Slider", "Side by side"]) {
  await page.getByRole("radio", { name: label, exact: true }).click();
  await page.waitForTimeout(150);
  if (label === "Slider") {
    const h = await page.locator(".split-handle").boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + 300);
    await page.mouse.down(); await page.mouse.move(h.x - 150, h.y + 300, { steps: 4 }); await page.mouse.up();
    const h2 = await page.locator(".split-handle").boundingBox();
    assert(Math.abs(h2.x - (h.x - 150 - h.width / 2)) < 3, "slider handle follows the mouse");
  }
  await page.screenshot({ path: join(out, `m2-mode-${label.replace(/ /g, "-").toLowerCase()}.png`) });
}
await page.getByLabel("Outlines").check();
await page.screenshot({ path: join(out, "m2-outlines.png") });
await page.getByLabel("Outlines").uncheck();

const before = await page.locator(".result-layer svg path").count();
await page.getByLabel("Number of colors").fill("3");
await busy(); await done();
const after = await page.locator('[data-testid="result-colors"] .swatch').count();
assert(after <= 3, `changing "Number of colors" to 3 re-ran the job (${after} colors, was ${before} shapes)`);
await page.getByLabel("Remove background").uncheck();
await busy(); await done();
await page.screenshot({ path: join(out, "m2-3colors-nobg.png") });

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM2 test passed. Screenshots in tests/out/");
