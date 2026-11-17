// Milestone 5 test: outline snap, border band, SVG/PDF/PNG/cut-line export,
// sticker border, and project save/load.
// Run with the dev server up:  node tests/m5.mjs [url]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const ref = join(here, "..", "reference");
const url = process.argv[2] ?? "http://localhost:5173/";

const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);

const done = () => page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 180000 });
const busy = () => page.waitForSelector('[data-testid="status"][data-status="busy"]', { timeout: 10000 }).catch(() => {});
const rerun = async () => { await busy(); await done(); };
const outline = () => page.getByTestId("outline-info").innerText();
const shapes = () => page.locator(".editor-layer path[data-shape-id]").count();
const texts = () => page.locator(".editor-layer [data-text-id]").count();
const fills = () => page.locator(".editor-layer path[data-shape-id]").evaluateAll((els) => els.map((e) => e.getAttribute("fill")));

/** Open the Export dialog, set it up with `setup`, export, and save the file. */
async function exportFile(format, file, setup = async () => {}) {
  await page.getByRole("button", { name: "Export…" }).click();
  await page.getByRole("radio", { name: format, exact: true }).click();
  await setup();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByTestId("export-go").click()]);
  const path = join(out, file);
  await dl.saveAs(path);
  return { path, name: dl.suggestedFilename() };
}

// ================= 1. Outline snap and border band =================
await page.locator('header input[type="file"]').setInputFiles(join(ref, "images", "radiant_heat.png"));
await page.getByLabel("Snap to palette").check();
await rerun();
assert((await outline()).includes("rounded rectangle"), "radiant_heat outline is snapped: " + (await outline()));
await page.getByLabel("Outline snap").selectOption("off");
await rerun();
assert((await outline()).includes("as traced"), "Outline snap Off keeps the traced outline");
await page.getByLabel("Outline snap").selectOption("circle");
await rerun();
assert((await outline()).match(/circle|ellipse/), "forcing Circle works: " + (await outline()));
await page.screenshot({ path: join(out, "m5-forced-circle.png") });
await page.getByLabel("Outline snap").selectOption("auto");
await rerun();

const w0 = parseInt((await outline()).split("border ")[1]);
await page.getByLabel("Border width adjust").fill("30");
await rerun();
const w1 = parseInt((await outline()).split("border ")[1]);
assert(w1 > w0, `border width adjust widens the band (${w0} -> ${w1} px)`);
await page.getByLabel("Border color from image").uncheck();
await page.getByLabel("Border color", { exact: true }).fill("#1c4062");
await rerun();
assert((await fills()).includes("#1C4062"), "a chosen border color is used");
await page.screenshot({ path: join(out, "m5-border-color.png") });
await page.getByLabel("Redraw outer border").uncheck();
await rerun();
assert(!(await outline()).includes("border"), "border can be turned off");
await page.getByLabel("Redraw outer border").check();
await page.getByLabel("Border color from image").check();
await page.getByLabel("Border width adjust").fill("7");
await rerun();

// ================= 2. Add some text, so exports include it =================
await page.getByRole("tab", { name: "Text" }).click();
await page.getByRole("button", { name: "Add text" }).click();
await page.getByLabel("Text content").fill("EXPORT");
await page.getByLabel("Text content").blur();
await page.locator('.panel.right input[type="file"]').setInputFiles(join(ref, "fonts", "RobotoSlab-Bold.woff"));
await page.waitForFunction(() => document.querySelector('select[aria-label="Font"]')?.selectedOptions[0]?.textContent === "RobotoSlab-Bold");
const outlineSlider = page.getByLabel("Outline width", { exact: true });
await outlineSlider.fill("6");
await outlineSlider.dispatchEvent("pointerup");
await page.keyboard.press("Escape");
const nShapes = await shapes();

// ================= 3. Exports =================
const svg = await exportFile("SVG", "m5-export.svg");
const svgText = readFileSync(svg.path, "utf8");
assert(svg.name === "radiant_heat.svg" && (svgText.match(/<path /g) ?? []).length >= nShapes && svgText.includes('<g id="text-1">'), "SVG export has shapes and text outlines");

const sticker = await exportFile("SVG", "m5-sticker.svg", async () => {
  await page.getByLabel("Add a sticker border").check();
  await page.getByLabel("Sticker border width").fill("40");
});
const stickerText = readFileSync(sticker.path, "utf8");
assert(stickerText.includes('id="sticker-border"') && stickerText.includes('viewBox="-40 -40'), "sticker border adds a padded white edge");

const cut = await exportFile("Cut line", "m5-cutline.svg", async () => {
  await page.getByLabel("Cut outside a sticker border").check();
  await page.getByLabel("Sticker border width").fill("40");
});
const cutText = readFileSync(cut.path, "utf8");
assert(cut.name === "radiant_heat-cutline.svg" && (cutText.match(/<path /g) ?? []).length === 1 && cutText.includes('fill="none"'), "cut line is one unfilled outline path");

const png = await exportFile("PNG", "m5-export.png", async () => {
  await page.getByLabel("Print width in inches").fill("2");
  await page.getByLabel("Resolution in DPI").fill("150");
  assert((await page.getByTestId("png-size").innerText()).startsWith("300 ×"), "PNG size preview: " + (await page.getByTestId("png-size").innerText()));
});
const pngBytes = readFileSync(png.path);
const pngW = pngBytes.readUInt32BE(16), pngH = pngBytes.readUInt32BE(20);
const phys = pngBytes.indexOf("pHYs");
const dpi = Math.round(pngBytes.readUInt32BE(phys + 4) * 0.0254);
assert(pngW === 300 && pngH > 200 && dpi === 150, `PNG is ${pngW} × ${pngH} px with ${dpi} DPI recorded`);

const pdf = await exportFile("PDF", "m5-export.pdf", async () => {
  await page.getByLabel("Print width in inches").fill("4");
});
const pdfBytes = readFileSync(pdf.path);
assert(pdfBytes.subarray(0, 5).toString() === "%PDF-" && statSync(pdf.path).size > 5000, `PDF export (${Math.round(statSync(pdf.path).size / 1024)} KB)`);
assert(!pdfBytes.includes("/Subtype /Image"), "PDF is pure vector (no embedded pictures)");

// Look at every output: render SVGs and PNG as images, and the PDF with pdf.js.
const sheet = await browser.newPage({ viewport: { width: 1600, height: 560 } });
const uri = (p, mime) => `data:${mime};base64,` + readFileSync(p).toString("base64");
await sheet.setContent(`<body style="margin:0;display:flex;gap:6px;background:#777;font:13px sans-serif;color:#fff">
  ${[["SVG", uri(svg.path, "image/svg+xml")], ["SVG + sticker border", uri(sticker.path, "image/svg+xml")],
     ["Cut line (drawn thicker here)", "data:image/svg+xml;base64," + Buffer.from(cutText.replace('stroke-width="1"', 'stroke-width="12"')).toString("base64")], ["PNG 300 px", uri(png.path, "image/png")]]
    .map(([l, s]) => `<div style="flex:1;text-align:center">${l}<img src="${s}" style="display:block;width:100%;height:500px;object-fit:contain;background:repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/20px 20px"></div>`).join("")}
  <div style="flex:1;text-align:center">PDF (pdf.js)<canvas id="pdf" style="display:block;width:100%;height:500px;object-fit:contain;background:#fff"></canvas></div>
  <script type="module">
    import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
    const bytes = Uint8Array.from(atob("${pdfBytes.toString("base64")}"), (c) => c.charCodeAt(0));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1.2 });
    const c = document.getElementById("pdf"); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    window.pdfPages = doc.numPages;
  </script></body>`);
await sheet.waitForFunction(() => window.pdfPages, null, { timeout: 30000 });
assert((await sheet.evaluate(() => window.pdfPages)) === 1, "PDF opens in pdf.js with one page");
await sheet.screenshot({ path: join(out, "m5-exports.png") });
await sheet.close();

// ================= 4. Project save / load =================
await page.getByLabel("Outline snap").selectOption("rect");
await rerun();
const before = { shapes: await shapes(), texts: await texts(), fills: (await fills()).join() };
await page.getByRole("tab", { name: "Shapes" }).click();
const [projDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save project" }).click()]);
const projPath = join(out, "m5-project.cvs.json");
await projDl.saveAs(projPath);
const proj = JSON.parse(readFileSync(projPath, "utf8"));
assert(projDl.suggestedFilename() === "radiant_heat.cvs.json" && proj.fonts.length === 1 && proj.texts.length === 1,
  `project file saved (${Math.round(statSync(projPath).size / 1024)} KB, with the uploaded font inside)`);

// Fresh page: nothing loaded, fonts not uploaded. Open the project like an image.
await page.reload();
await page.locator('header input[type="file"]').setInputFiles(projPath);
await done();
await page.waitForTimeout(500);
const after = { shapes: await shapes(), texts: await texts(), fills: (await fills()).join() };
assert(after.shapes === before.shapes && after.fills === before.fills, `project restores the edited shapes (${after.shapes})`);
assert(after.texts === 1, "project restores the text object, drawn with its saved font");
assert((await page.getByLabel("Outline snap").inputValue()) === "rect", "project restores the clean-up settings");
assert((await page.locator(".file-label").innerText()).includes("radiant_heat.png"), "project restores the original image");
await page.screenshot({ path: join(out, "m5-project-reopened.png") });

// A file that is not a project gives a clear message.
await page.locator('header input[type="file"]').setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
await page.waitForSelector(".error-bar");
assert((await page.locator(".error-bar").innerText()).includes("not a Caveman Vector Studio project"), "a wrong .json file shows a clear error");

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM5 test passed. Screenshots in tests/out/");
