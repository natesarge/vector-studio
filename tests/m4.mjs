// Milestone 4 test: text tool, fonts, effects, and Replace lettering.
// Run with the dev server up:  node tests/m4.mjs [url]
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
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
const shot = (name) => page.screenshot({ path: join(out, `m4-${name}.png`) });
const shapes = () => page.locator(".editor-layer path[data-shape-id]").count();
const texts = () => page.locator(".editor-layer [data-text-id]").count();
const textD = () => page.locator(".editor-layer [data-text-id] path").last().getAttribute("d");
const textBox = () => page.locator(".editor-layer [data-text-id]").last().boundingBox();
const slide = async (label, value) => {
  const s = page.getByLabel(label, { exact: true });
  await s.fill(String(value));
  await s.dispatchEvent("pointerup");
};
const open = async (file) => {
  await page.locator('header input[type="file"]').setInputFiles(join(ref, "images", file));
  await page.waitForFunction((n) => document.querySelector(".file-label")?.textContent.includes(n), file);
  if (!(await page.getByLabel("Snap to palette").isChecked())) await page.getByLabel("Snap to palette").check();
  await page.waitForTimeout(600);
  await done();
};
/** Draw a box (two corners) or a lasso (list of points) on the result, as fractions of the picture. */
const drawRegion = async (points, lasso = false) => {
  await page.getByRole("button", { name: lasso ? "Draw lasso" : "Draw box" }).click();
  const r = await page.locator('[data-pane="result"] .artboard').boundingBox();
  const P = ([fx, fy]) => [r.x + r.width * fx, r.y + r.height * fy];
  await page.mouse.move(...P(points[0]));
  await page.mouse.down();
  for (const c of points.slice(1)) await page.mouse.move(...P(c), { steps: 5 });
  await page.mouse.up();
};
const dragRegion = (x0, y0, x1, y1, lasso = false) =>
  drawRegion(lasso ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 0.01]] : [[x0, y0], [x1, y1]], lasso);

// ================= 1. Add text and style it =================
await open("hct1.jpg");
const shapes0 = await shapes();
await page.getByRole("tab", { name: "Text" }).click();
await page.getByRole("button", { name: "Add text" }).click();
assert((await texts()) === 1, "Add text creates a text object");
await page.getByTestId("text-box").waitFor();
await page.getByLabel("Text content").fill("HELLO\nWORLD");
await page.getByLabel("Text content").blur();
let d0 = await textD();
assert(d0.length > 500, "text is drawn as outlines (" + d0.length + " characters of path data)");

// fonts: bundled list, upload, Google Fonts
const fontOptions = () => page.getByLabel("Font", { exact: true }).locator("option").allInnerTexts();
assert((await fontOptions()).join("|").includes("Alfa Slab One") && (await fontOptions()).length >= 3, "bundled fonts are listed: " + (await fontOptions()).join(", "));
await page.getByLabel("Font", { exact: true }).selectOption({ label: "Roboto Slab Black" });
assert((await textD()) !== d0, "changing the font changes the outlines");
await page.locator('.panel.right input[type="file"]').setInputFiles(join(ref, "fonts", "RobotoSlab-Bold.woff"));
await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Font"] option')].some((o) => o.textContent === "RobotoSlab-Bold"));
assert(true, "uploaded font file is added and selected");
await page.getByRole("button", { name: "Google Fonts…" }).click();
await page.getByLabel("Search fonts by name").fill("Bebas Neue");
await page.getByRole("button", { name: "Add Bebas Neue" }).click({ timeout: 30000 });
await page.waitForFunction(() => document.querySelector('select[aria-label="Font"]')?.selectedOptions[0]?.textContent.includes("Bebas Neue"), null, { timeout: 30000 });
assert(true, "Google font downloaded and applied (Bebas Neue)");
await shot("fonts");
await page.getByLabel("Font", { exact: true }).selectOption({ label: "Alfa Slab One" });

// every control changes the drawing
const check = async (label, value, what) => {
  const before = await textD();
  await slide(label, value);
  assert((await textD()) !== before, what);
};
await check("Size", 200, "Size slider");
await check("Letter spacing", 0.2, "Letter spacing slider");
await check("Line height", 1.4, "Line height slider");
await check("Rotation", -10, "Rotation slider");
await check("Slant", 15, "Slant slider");
await check("Baseline slope", 5, "Baseline slope slider");
await shot("styled");
await page.getByRole("radio", { name: "Bend" }).click();
await check("Bend", 45, "Bend curve");
await shot("bend");
await page.getByRole("radio", { name: "Circle" }).click();
await check("Radius", 500, "Circle radius");
let before = await textD();
await page.getByLabel("Along the bottom").check();
assert((await textD()) !== before, "Along the bottom flips the circle");
await shot("circle-bottom");
await page.getByRole("radio", { name: "Straight" }).click();
await check("Wave", 25, "Wave");
await page.getByLabel("Letter size variation").selectOption("ends");
await check("Amount", 60, "Bigger first and last letters");
await shot("wave-sizes");
await slide("Wave", 0);

// effects
const parts = () => page.locator(".editor-layer [data-text-id] path").count();
assert((await parts()) === 1, "plain text is one path");
await slide("Outline width", 8);
assert((await page.locator(".editor-layer [data-text-id] path").last().getAttribute("stroke")) !== null, "outline adds a stroke");
await slide("3D depth", 30);
assert((await parts()) > 10, "3D depth adds stacked copies (" + (await parts()) + " paths)");
await page.getByLabel("Drop shadow").check();
await shot("effects");

// move by dragging; undo
const b0 = await textBox();
await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2); await page.mouse.down();
await page.mouse.move(b0.x + b0.width / 2 + 80, b0.y + b0.height / 2 + 50, { steps: 5 }); await page.mouse.up();
const b1 = await textBox();
assert(Math.abs(b1.x - b0.x - 80) < 3 && Math.abs(b1.y - b0.y - 50) < 3, "dragging the text moves it");
await page.getByRole("button", { name: "Undo" }).click();
assert(Math.abs((await textBox()).x - b0.x) < 2, "undo moves it back");

// export has the text as outlines
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export SVG" }).click()]);
await dl.saveAs(join(out, "m4-export.svg"));
const svg = readFileSync(join(out, "m4-export.svg"), "utf8");
assert(svg.includes('<g id="text-1">') && !svg.includes("<text"), "exported SVG contains the text as outlines, not a <text> element");

// duplicate, delete
await page.getByRole("button", { name: "Duplicate" }).click();
assert((await texts()) === 2, "Duplicate makes a second text");
await page.keyboard.press("Escape");
await page.locator('[data-testid="text-list"] button').last().click();
await page.getByRole("button", { name: "Delete text" }).click();
await page.locator('[data-testid="text-list"] button').first().click();
await page.getByRole("button", { name: "Delete text" }).click();
assert((await texts()) === 0, "Delete removes text objects");

// ================= 2. Replace lettering: straight text =================
await dragRegion(0.345, 0.795, 0.655, 0.885);
await page.getByTestId("text-note").waitFor();
console.log("    " + (await page.getByTestId("text-note").innerText()));
assert((await texts()) === 1 && (await shapes()) < shapes0, `box around TRIBE: ${shapes0 - (await shapes())} shapes replaced by a text object`);
await page.getByLabel("Text content").fill("TRIBE");
await page.getByLabel("Text content").blur();
await dragRegion(0.17, 0.722, 0.83, 0.793, true);
assert((await texts()) === 2, "lasso around HAPPY CAVEMAN makes a second text object");
await page.getByLabel("Text content").fill("HAPPY CAVEMAN");
await page.getByLabel("Text content").blur();
await page.keyboard.press("Escape");
await shot("replace-straight");
await page.getByRole("button", { name: "Undo" }).click(); // undo typing
await page.getByRole("button", { name: "Undo" }).click(); // undo the replacement
assert((await texts()) === 1, "one undo step restores the traced lettering");
await page.getByRole("button", { name: "Redo" }).click();
await page.getByRole("button", { name: "Redo" }).click();

// an empty area finds nothing and says so
await dragRegion(0.02, 0.02, 0.08, 0.08);
assert((await page.getByTestId("text-note").innerText()).startsWith("No complete shapes"), "empty area gives a helpful message");

// ================= 3. Replace lettering: curved text =================
await open("no_smoke.png");
await page.getByRole("tab", { name: "Text" }).click();
// Curved text needs the lasso: a box that holds the whole arc would also hold other things.
await drawRegion([[0.238, 0.803], [0.262, 0.742], [0.327, 0.752], [0.515, 0.8], [0.703, 0.746], [0.77, 0.732],
  [0.8, 0.795], [0.644, 0.9], [0.515, 0.918], [0.366, 0.9]], true);
await page.getByTestId("text-note").waitFor();
const note = await page.getByTestId("text-note").innerText();
console.log("    " + note);
assert(note.includes("curved"), "bottom lettering on the patch is detected as curved");
assert(await page.getByRole("radio", { name: "Circle" }).getAttribute("aria-checked") === "true", "text object uses the Circle curve");
assert(await page.getByLabel("Along the bottom").isChecked(), "and sits along the bottom of the circle");
await page.getByLabel("Text content").fill("HAPPY CAVEMAN");
await page.getByLabel("Text content").blur();
await page.getByLabel("Font", { exact: true }).selectOption({ label: "Roboto Slab Black" });
await page.keyboard.press("Escape");
await shot("replace-arc");

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM4 test passed. Screenshots in tests/out/");
