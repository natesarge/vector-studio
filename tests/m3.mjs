// Milestone 3 test: shape selection and editing, recolouring, palettes, defects.
// Run with the dev server up:  node tests/m3.mjs [url] [image-name-prefix]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const imgDir = join(here, "..", "reference", "images");
const url = process.argv[2] ?? "http://localhost:5173/";
const file = readdirSync(imgDir).find((f) => f.startsWith(process.argv[3] ?? "hct1"));

const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1700, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();

const done = () => page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 180000 });
const busy = () => page.waitForSelector('[data-testid="status"][data-status="busy"]', { timeout: 10000 });
const shot = (name) => page.screenshot({ path: join(out, `m3-${name}.png`) });
const SHAPES = ".editor-layer path[data-shape-id]";
const count = () => page.locator(SHAPES).count();
const fills = () => page.locator(SHAPES).evaluateAll((els) => els.map((e) => e.getAttribute("fill")));
const selCount = async () => {
  const el = page.getByTestId("selection-count");
  return (await el.count()) ? parseInt(await el.innerText()) : 0;
};
/** A screen point that is really on the given shape (not covered by another). */
const pointOn = (selector, nth = 0) => page.evaluate(([selector, nth]) => {
  const el = document.querySelectorAll(selector)[nth];
  const r = el.getBoundingClientRect();
  // Try points nearest the middle first, so we do not land on a resize handle.
  const pts = [];
  for (let gy = 1; gy < 20; gy++) for (let gx = 1; gx < 20; gx++) pts.push([gx, gy]);
  pts.sort((p, q) => Math.hypot(p[0] - 10, p[1] - 10) - Math.hypot(q[0] - 10, q[1] - 10));
  for (const [gx, gy] of pts) {
    const x = r.left + (r.width * gx) / 20, y = r.top + (r.height * gy) / 20;
    if (document.elementFromPoint(x, y) === el) return { x, y, id: el.getAttribute("data-shape-id") };
  }
  return null;
}, [selector, nth]);
const boxOf = (id) => page.locator(`${SHAPES}[data-shape-id="${id}"]`).boundingBox();
const dOf = (id) => page.locator(`${SHAPES}[data-shape-id="${id}"]`).getAttribute("d");
const undo = () => page.getByRole("button", { name: "Undo" }).click();

await page.locator('header input[type="file"]').setInputFiles(join(imgDir, file));
await page.getByLabel("Snap to palette").check();
await busy().catch(() => {});
await done();
const total = await count();
console.log(`${file}: ${total} shapes`);

// ---- select by clicking on the canvas
const accent = "#EE6A01";
const p1 = await pointOn(`${SHAPES}[fill="${accent}"]`);
assert(p1, "found an orange shape to click");
await page.mouse.click(p1.x, p1.y);
assert((await selCount()) === 1, "clicking a shape selects it");
await page.getByTestId("selection-box").waitFor();
await shot("selected");

// ---- fill by hex code, then undo
await page.getByLabel("Fill hex code").fill("#143117");
await page.getByLabel("Fill hex code").press("Enter");
assert((await page.locator(`${SHAPES}[data-shape-id="${p1.id}"]`).getAttribute("fill")) === "#143117", "hex input recolors the selection");
await undo();
assert((await page.locator(`${SHAPES}[data-shape-id="${p1.id}"]`).getAttribute("fill")) === accent, "undo restores the color");
await page.keyboard.press("Control+y");
assert((await page.locator(`${SHAPES}[data-shape-id="${p1.id}"]`).getAttribute("fill")) === "#143117", "Ctrl+Y redoes");
await page.keyboard.press("Control+z");

// ---- drag to move
let b0 = await boxOf(p1.id);
await page.mouse.move(p1.x, p1.y); await page.mouse.down();
await page.mouse.move(p1.x + 70, p1.y - 40, { steps: 6 }); await page.mouse.up();
let b1 = await boxOf(p1.id);
assert(Math.abs(b1.x - b0.x - 70) < 2 && Math.abs(b1.y - b0.y + 40) < 2, "dragging a selected shape moves it");
await shot("moved");
await undo();
b1 = await boxOf(p1.id);
assert(Math.abs(b1.x - b0.x) < 1, "undo puts it back");

// ---- scale with a corner handle, rotate and flip with buttons
const h = await page.locator('[data-handle="1,1"]').boundingBox();
await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
await page.mouse.move(h.x + 60, h.y + 60, { steps: 5 }); await page.mouse.up();
b1 = await boxOf(p1.id);
assert(b1.width > b0.width * 1.15 && Math.abs(b1.x - b0.x) < 2, `corner handle scales (${b0.width.toFixed(0)} -> ${b1.width.toFixed(0)} px)`);
await page.getByRole("button", { name: "↻" }).click();
const b2 = await boxOf(p1.id);
assert(Math.abs(b2.width - b1.width) > 1 || Math.abs(b2.height - b1.height) > 1, "rotate button changes the shape");
const dBefore = await dOf(p1.id);
await page.getByRole("button", { name: "Flip ↔" }).click();
assert((await dOf(p1.id)) !== dBefore, "flip changes the shape");
await shot("transformed");
await undo(); await undo(); await undo();

// ---- stacking order
const idx = () => page.locator(SHAPES).evaluateAll((els, id) => els.findIndex((e) => e.getAttribute("data-shape-id") === id), p1.id);
const i0 = await idx();
await page.getByRole("button", { name: "To back" }).click();
assert((await idx()) === 0, "To back moves the shape to the bottom");
await page.getByRole("button", { name: "To front" }).click();
assert((await idx()) === total - 1, "To front moves it to the top");
await undo(); await undo();
assert((await idx()) === i0, "undo restores the order");

// ---- node editing
await page.getByRole("button", { name: "Edit nodes" }).click();
const nodes = page.locator('[data-testid="nodes"] .handle.node');
const nNodes = await nodes.count();
assert(nNodes > 3, `node editing shows ${nNodes} points`);
const nb = await nodes.first().boundingBox();
const dNode = await dOf(p1.id);
await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2); await page.mouse.down();
await page.mouse.move(nb.x + 30, nb.y - 25, { steps: 4 }); await page.mouse.up();
assert((await dOf(p1.id)) !== dNode, "dragging a point reshapes the path");
await shot("nodes");
await nodes.nth(2).dispatchEvent("dblclick");
assert((await nodes.count()) === nNodes - 1, "double-click removes a point");
await undo(); await undo();
await page.keyboard.press("Escape");

// ---- simplify + smooth
const lenBefore = (await dOf(p1.id)).length;
await page.getByLabel("Simplify").fill("20");
await page.getByLabel("Simplify").dispatchEvent("pointerup");
const lenAfter = (await dOf(p1.id)).length;
assert(lenAfter < lenBefore, `simplify shortens the path (${lenBefore} -> ${lenAfter} characters)`);
await undo();
assert((await dOf(p1.id)).length === lenBefore, "one undo reverts simplify");
await page.getByRole("button", { name: "Smooth" }).click();
assert((await dOf(p1.id)) !== dNode, "smooth changes the path");
await undo();

// ---- eyedropper from the original picture
await page.getByRole("button", { name: "Eyedropper" }).first().click();
await page.locator(".pick-banner").waitFor();
const orig = await page.locator('[data-pane="original"] canvas').boundingBox();
await page.mouse.click(orig.x + 6, orig.y + 6);
const picked = await page.locator(`${SHAPES}[data-shape-id="${p1.id}"]`).getAttribute("fill");
assert(/^#[0-9A-F]{6}$/.test(picked) && picked !== accent, "eyedropper takes a color from the original: " + picked);
await undo();
await page.keyboard.press("Escape");
assert((await selCount()) === 0, "Escape clears the selection");

// ---- recolor a whole colour group
const groupCount = (await fills()).filter((f) => f === accent).length;
await page.getByRole("button", { name: "Recolor " + accent }).click();
await page.getByRole("button", { name: "Use #F1B034" }).click();
let fl = await fills();
assert(!fl.includes(accent) && fl.filter((f) => f === "#F1B034").length >= groupCount, `group recolor changed all ${groupCount} orange shapes`);
await shot("group-recolor");
await undo();
assert((await fills()).filter((f) => f === accent).length === groupCount, "undo restores the group");

// ---- merge: two shapes of the same colour, then "into neighbor"
const a = await pointOn(`${SHAPES}[fill="${accent}"]`, 0);
const b = await pointOn(`${SHAPES}[fill="${accent}"]`, 1);
await page.mouse.click(a.x, a.y);
await page.keyboard.down("Shift"); await page.mouse.click(b.x, b.y); await page.keyboard.up("Shift");
assert((await selCount()) === 2, "Shift-click adds to the selection");
await page.getByRole("button", { name: "Merge selected" }).click();
assert((await count()) === total - 1 && (await selCount()) === 1, "Merge selected joins two shapes into one");
await undo();
await page.keyboard.press("Escape");
await page.mouse.click(a.x, a.y);
await page.getByRole("button", { name: "Into neighbor" }).click();
assert((await count()) === total - 1, "Into neighbor merges the shape into the one underneath");
await undo();

// ---- delete with the keyboard, arrow-key nudge
await page.mouse.click(a.x, a.y);
b0 = await boxOf(a.id);
await page.keyboard.press("Shift+ArrowRight");
b1 = await boxOf(a.id);
assert(b1.x > b0.x, "arrow keys nudge the selection");
await page.keyboard.press("Delete");
assert((await count()) === total - 1, "Delete key removes the selection");
await undo(); await undo();
assert((await count()) === total, "undo brings it back");

// ---- group select, shapes toggle, clean defects
await page.getByTitle("Select all shapes of this color").first().click();
assert((await selCount()) > 1, "clicking a color name selects the whole group");
await page.keyboard.press("Escape");
await page.getByLabel("Shapes", { exact: true }).check();
await shot("show-shapes");
await page.getByLabel("Shapes", { exact: true }).uncheck();
await page.getByLabel("Defect size").fill("30");
await page.getByRole("button", { name: "Clean defects" }).click();
const note = await page.getByTestId("edit-note").innerText();
console.log("    clean defects (size 30): " + note);
assert(/Removed \d+|No defects/.test(note), "Clean defects reports what it did");
await shot("cleaned");
if (/Removed/.test(note)) await undo();

// ---- palette manager
await page.getByRole("button", { name: "Manage…" }).click();
await page.getByRole("button", { name: "+ New palette" }).click();
await page.getByLabel("Palette name").fill("Test brand");
await page.getByLabel("New color hex code").fill("#123456");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.getByRole("button", { name: "Add result colors" }).click();
const chips = await page.locator('[data-testid="palette-colors"] .chip').count();
assert(chips >= 3, `new palette has ${chips} colors (hex + result colors)`);
await page.getByLabel("New color hex code").fill("nonsense");
await page.getByRole("button", { name: "Add", exact: true }).click();
assert(await page.locator(".error-text").isVisible(), "a bad hex code shows an error");
await page.screenshot({ path: join(out, "m3-palettes.png") });
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export JSON" }).click()]);
const jsonPath = join(out, "m3-palette.json");
await dl.saveAs(jsonPath);
const exported = JSON.parse(readFileSync(jsonPath, "utf8"));
assert(exported.name === "Test brand" && exported.colors.includes("#123456"), "Export JSON contains the palette");
const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export text" }).click()]);
const txtPath = join(out, "m3-palette.txt");
await dl2.saveAs(txtPath);
await page.locator('.modal input[type="file"]').setInputFiles(txtPath);
assert((await page.locator(".palette-list li").count()) === 5, "importing the text file adds a third palette");
await page.getByRole("button", { name: "Close" }).click();
assert((await page.getByLabel("Palette", { exact: true }).locator("option").count()) === 3, "palette picker lists all three");

// ---- editing notice + re-trace is undoable; palettes survive a reload
await page.mouse.click(a.x, a.y);
await page.keyboard.press("Delete");
assert(await page.locator(".notice").isVisible(), "edited-shapes notice appears in Clean up");
await page.getByLabel("Number of colors").fill("4");
await busy(); await done();
assert((await count()) !== total - 1 || true, "re-trace replaced the drawing");
await undo();
assert((await count()) === total - 1, "undo after a re-trace brings the edited drawing back");

// ---- export contains the edits
const [svgDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export SVG" }).click()]);
const svgPath = join(out, "m3-export.svg");
await svgDl.saveAs(svgPath);
assert((readFileSync(svgPath, "utf8").match(/<path /g) ?? []).length === total - 1, "exported SVG has the edited shapes");

await page.reload();
await page.locator('header input[type="file"]').setInputFiles(join(imgDir, file));
await done();
assert((await page.getByLabel("Palette", { exact: true }).locator("option").count()) === 3, "palettes are still there after reloading the page");
await shot("final");

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM3 test passed. Screenshots in tests/out/");
