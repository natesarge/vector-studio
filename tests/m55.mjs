// Milestone 5.5 test: flatten overlaps, clean ring border, break apart, knife,
// node editing, compare, hover / Alt+click / layers highlight.
// Also builds before/after picture sheets for flatten (item 5) and ring (item 2).
// Run with the dev server up:  node tests/m55.mjs [url]
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const imgDir = join(here, "..", "reference", "images");
const url = process.argv[2] ?? "http://localhost:5173/";

const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
const lab = await browser.newPage(); // scratch page for rendering and measuring
await lab.setContent("<body></body>");
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);

const SHAPES = ".editor-layer path[data-shape-id]";
const done = () => page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 240000 });
const rerun = async () => {
  await page.waitForSelector('[data-testid="status"][data-status="busy"]', { timeout: 10000 }).catch(() => {});
  await done();
};
const count = () => page.locator(SHAPES).count();
const shapesNow = () => page.locator(SHAPES).evaluateAll((els) => els.map((e) => ({ id: e.dataset.shapeId, d: e.getAttribute("d"), fill: e.getAttribute("fill") })));
const size = () => page.evaluate(() => { const v = document.querySelector(".editor-layer").viewBox.baseVal; return { W: v.width, H: v.height }; });
const selCount = async () => {
  const el = page.getByTestId("selection-count");
  return (await el.count()) ? parseInt(await el.innerText()) : 0;
};
/** Click while holding a modifier key (page.mouse.click itself ignores modifiers). */
const clickWith = async (key, x, y) => {
  await page.keyboard.down(key);
  await page.mouse.click(x, y);
  await page.keyboard.up(key);
};
/** A screen point that really is on the shape (not covered), middle-most first. */
const pointOn = (selector, nth = 0) => page.evaluate(([selector, nth]) => {
  const el = document.querySelectorAll(selector)[nth];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pts = [];
  for (let gy = 1; gy < 20; gy++) for (let gx = 1; gx < 20; gx++) pts.push([gx, gy]);
  pts.sort((p, q) => Math.hypot(p[0] - 10, p[1] - 10) - Math.hypot(q[0] - 10, q[1] - 10));
  for (const [gx, gy] of pts) {
    const x = r.left + (r.width * gx) / 20, y = r.top + (r.height * gy) / 20;
    if (document.elementFromPoint(x, y) === el) return { x, y, id: el.getAttribute("data-shape-id"), box: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }
  return null;
}, [selector, nth]);
const open = async (file) => {
  await page.locator('header input[type="file"]').setInputFiles(join(imgDir, file));
  await page.waitForFunction((n) => document.querySelector(".file-label")?.textContent.includes(n), file);
  if (!(await page.getByLabel("Snap to palette").isChecked())) await page.getByLabel("Snap to palette").check();
  await rerun();
};
const setFlatten = async (on) => {
  const box = page.getByLabel("Flatten overlaps");
  if ((await box.isChecked()) !== on) { await box.setChecked(on); await rerun(); }
};
const exportPng = async (name) => {
  await page.getByRole("button", { name: "Export…" }).click();
  await page.getByRole("radio", { name: "PNG", exact: true }).click();
  await page.getByLabel("Print width in inches").fill("3");
  await page.getByLabel("Resolution in DPI").fill("300");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-go").click()]);
  const p = join(out, name);
  await dl.saveAs(p);
  return "data:image/png;base64," + readFileSync(p).toString("base64");
};
const exportSvg = async (name) => {
  await page.getByRole("button", { name: "Export…" }).click();
  await page.getByRole("radio", { name: "SVG", exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-go").click()]);
  const p = join(out, name);
  await dl.saveAs(p);
  return readFileSync(p, "utf8");
};

// ---------------------------------------------------------------- measuring helpers (run in the lab page)
/** Share of covered area painted by two or more shapes (0 = no overlaps). */
const overlapShare = (shapes, W, H) => lab.evaluate(([shapes, W, H]) => {
  const k = 700 / W, c = document.createElement("canvas");
  c.width = 700; c.height = Math.round(H * k);
  const g = c.getContext("2d");
  g.setTransform(k, 0, 0, k, 0, 0);
  g.globalCompositeOperation = "lighter";
  g.fillStyle = "rgb(100,0,0)";
  for (const s of shapes) g.fill(new Path2D(s.d));
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let covered = 0, twice = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] >= 90) covered++; if (px[i] >= 190) twice++; }
  return twice / Math.max(1, covered);
}, [shapes, W, H]);
/** Share of pixels that differ visibly between two pictures (data URLs) drawn at the same size. */
const pixelDiff = (srcA, srcB) => lab.evaluate(async ([a, b]) => {
  const draw = async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 900; c.height = Math.round((900 * img.naturalHeight) / img.naturalWidth);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height).data;
  };
  const [p, q] = [await draw(a), await draw(b)];
  let diff = 0, n = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8 && q[i + 3] < 8) continue;
    n++;
    if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]), Math.abs(p[i + 3] - q[i + 3])) > 48) diff++;
  }
  return diff / n;
}, [srcA, srcB]);
/** SVG where every shape gets its own see-through colour: overlaps show up as mixed colours. */
const xray = (shapes, W, H) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
  shapes.map((s, i) => `<path d="${s.d}" fill="hsl(${(i * 137) % 360} 85% 55%)" fill-opacity="0.45" stroke="#000" stroke-width="${W / 700}"/>`).join("") + `</svg>`;
const uri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
/** Save a row of labelled pictures (and optional zoomed crops) as one PNG. */
async function sheet(file, cells, crop) {
  const h = crop ? 1000 : 560;
  const p = await browser.newPage({ viewport: { width: 470 * cells.length, height: h } });
  const pic = (src, style) => `<div style="height:440px;margin-top:2px;background:url('${src}') ${style}, repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 0 0/20px 20px"></div>`;
  await p.setContent(`<body style="margin:0;display:flex;gap:6px;background:#666;font:13px sans-serif;color:#fff">` +
    cells.map(([label, src]) => `<div style="flex:1;text-align:center">${label}${pic(src, "center/contain no-repeat")}${crop ? pic(src, `${crop[0]}% ${crop[1]}%/${crop[2]}% auto no-repeat`) : ""}</div>`).join("") + `</body>`);
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(out, file) });
  await p.close();
}

// ================= Item 5: flatten overlaps (all reference images) =================
const images = ["hct1.jpg", "no_smoke.png", "radiant_heat.png", "tribe.png"];
for (const file of process.env.ONLY_RING ? [] : images) {
  const name = file.replace(/\.[^.]+$/, "");
  await open(file);
  const { W, H } = await size();
  await setFlatten(false);
  const stacked = await shapesNow();
  const svgStacked = await exportSvg(`m55-${name}-stacked.svg`);
  const pngStacked = await exportPng(`m55-${name}-stacked.png`);
  await setFlatten(true);
  const flat = await shapesNow();
  const svgFlat = await exportSvg(`m55-${name}-flat.svg`);
  const pngFlat = await exportPng(`m55-${name}-flat.png`);
  const [oS, oF, diff] = [await overlapShare(stacked, W, H), await overlapShare(flat, W, H), await pixelDiff(pngStacked, pngFlat)];
  console.log(`    ${name}: ${stacked.length} -> ${flat.length} shapes · overlap ${(oS * 100).toFixed(1)}% -> ${(oF * 100).toFixed(2)}% · export pixels changed ${(diff * 100).toFixed(2)}%`);
  assert(oF < 0.01 && oF < oS, `${name}: flattened shapes do not overlap`);
  assert(diff < 0.005, `${name}: flattened PNG export looks the same (${(diff * 100).toFixed(2)}% of pixels differ)`);
  await sheet(`m55-flatten-${name}.png`, [
    ["Before: stacked shapes (each shape its own colour)", uri(xray(stacked, W, H))],
    ["After: flattened (no overlaps)", uri(xray(flat, W, H))],
    ["Export before", uri(svgStacked)],
    ["Export after", uri(svgFlat)],
  ], [50, 78, 300]);
}

// ================= Item 2: clean ring border =================
for (const file of images) {
  const name = file.replace(/\.[^.]+$/, "");
  await open(file);
  const redraw = await exportSvg(`m55-${name}-redraw.svg`);
  await page.getByLabel("Border mode").selectOption("ring");
  await rerun();
  const ringSvg = await exportSvg(`m55-${name}-ring.svg`);
  const info = await page.getByTestId("outline-info").innerText();
  const ringSize = await page.getByTestId("ring-size").innerText();
  console.log(`    ${name}: ${info} · ${ringSize}`);
  const { W, H } = await size();
  const all = await shapesNow();
  assert(/ring \d+ px/.test(info) && /mm .* in/.test(ringSize), `${name}: ring width shown in px and mm/in`);
  assert((await overlapShare(all, W, H)) < 0.01, `${name}: ring + clipped artwork do not overlap`);
  await page.getByLabel("Second ring", { exact: true }).check();
  await rerun();
  const ring2Svg = await exportSvg(`m55-${name}-ring2.svg`);
  await sheet(`m55-ring-${name}.png`, [
    ["Before: redraw traced band", uri(redraw)],
    ["After: clean ring", uri(ringSvg)],
    ["Clean ring + second ring", uri(ring2Svg)],
  ], [50, 2, 400]);
}

// Detailed ring checks on the last image (tribe): names, colour, clip off.
const names = await page.locator('[data-testid="color-groups"] .shape-list button').allInnerTexts().catch(() => []);
const ringPt = await page.evaluate(() => {
  const svg = document.querySelector('[data-pane="result"] .editor-layer');
  const paths = [...svg.querySelectorAll("path[data-shape-id]")];
  const ring = paths[paths.length - 2]; // second ring is last, border ring just under it
  const r = ring.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + 4, id: ring.dataset.shapeId };
});
await page.mouse.click(ringPt.x, ringPt.y);
await page.waitForTimeout(200);
assert((await page.locator(`[data-row-id="${ringPt.id}"]`).innerText()).includes("Border ring"), "the ring is its own named shape, highlighted in the layers list");
await page.getByRole("button", { name: "Use #F1B034" }).first().click(); // ring colour swatch in Clean up
await rerun();
assert((await shapesNow()).some((s) => s.fill === "#F1B034"), "ring color picker recolors the ring");
await page.getByLabel("Clip artwork inside border").uncheck();
await rerun();
const { W: tw, H: th } = await size();
const unclipped = await overlapShare(await shapesNow(), tw, th);
assert(unclipped > 0.01, `with clipping off, artwork continues under the ring (${(unclipped * 100).toFixed(1)}% overlap)`);
void names;

// Alt+click cycles through the shapes stacked under one point (ring over artwork).
await page.keyboard.press("Escape");
await clickWith("Alt", ringPt.x, ringPt.y + 10);
const first = await page.evaluate(() => document.querySelector('[data-testid="selection-count"]') && [...document.querySelectorAll('[data-row-id]')].find((b) => b.classList.contains("on"))?.dataset.rowId);
await clickWith("Alt", ringPt.x, ringPt.y + 10);
const second = await page.evaluate(() => [...document.querySelectorAll('[data-row-id]')].find((b) => b.classList.contains("on"))?.dataset.rowId);
assert(first && second && first !== second, `Alt+click cycles to the shape underneath (${first} -> ${second})`);
await page.screenshot({ path: join(out, "m55-ring-ui.png") });

// ================= Items 1, 3, 4, 5 (selection) on hct1 =================
await open("hct1.jpg");
await page.getByLabel("Border mode").selectOption("redraw");
await rerun();
await page.getByRole("radio", { name: "Result", exact: true }).click();
await page.waitForTimeout(300);
const total = await count();

// Hover highlight
const o1 = await pointOn(`${SHAPES}[fill="#EE6A01"]`);
await page.mouse.move(o1.x, o1.y);
await page.waitForSelector('[data-testid="hover-outline"]', { timeout: 3000 });
assert(true, "hovering a shape outlines it");

// Click selects it and reveals it in the layers list
await page.mouse.click(o1.x, o1.y);
const row = page.locator(`[data-row-id="${o1.id}"]`);
assert((await row.getAttribute("class"))?.includes("on") && (await row.isVisible()), "clicking a shape highlights its row in the layers list");

// Simplify and Smooth change only the selected shape
const before = await shapesNow();
await page.getByLabel("Simplify").fill("15");
await page.getByLabel("Simplify").dispatchEvent("pointerup");
let after = await shapesNow();
assert(after.filter((s, i) => s.d !== before[i].d).map((s) => s.id).join() === o1.id, "Simplify changes only the selected shape");
await page.getByRole("button", { name: "Undo" }).click();
await page.getByRole("button", { name: "Smooth", exact: true }).click();
after = await shapesNow();
assert(after.filter((s, i) => s.d !== before[i].d).map((s) => s.id).join() === o1.id, "Smooth changes only the selected shape");
await page.getByRole("button", { name: "Undo" }).click();

// Knife: line across the shape
await page.getByRole("button", { name: "Knife: line" }).click();
const kb = o1.box;
await page.mouse.move(kb.x - 30, kb.y + kb.h / 2);
await page.mouse.down();
await page.mouse.move(kb.x + kb.w + 30, kb.y + kb.h / 2 + 4, { steps: 6 });
await page.mouse.up();
assert((await count()) === total + 1 && (await selCount()) === 2, "Knife: line cuts the shape into two (both selected)");
const cutFills = (await shapesNow()).filter((s) => s.fill === "#EE6A01").length;
await page.screenshot({ path: join(out, "m55-knife.png") });
await page.getByRole("button", { name: "Undo" }).click();

// Knife: lasso around the left half
await page.mouse.click(o1.x, o1.y);
await page.getByRole("button", { name: "Knife: lasso" }).click();
await page.mouse.move(kb.x - 20, kb.y - 20);
await page.mouse.down();
for (const [x, y] of [[kb.x + kb.w / 2, kb.y - 20], [kb.x + kb.w / 2, kb.y + kb.h + 20], [kb.x - 20, kb.y + kb.h + 20], [kb.x - 20, kb.y - 15]]) await page.mouse.move(x, y, { steps: 5 });
await page.mouse.up();
assert((await count()) === total + 1, "Knife: lasso cuts off the part inside the loop");
assert(cutFills >= 2, "pieces keep the original color");
await page.getByRole("button", { name: "Undo" }).click();

// Break apart: merge two separate shapes into one, then break it apart again
const a = await pointOn(`${SHAPES}[fill="#EE6A01"]`, 0);
const b = await pointOn(`${SHAPES}[fill="#EE6A01"]`, 1);
await page.mouse.click(a.x, a.y);
await clickWith("Shift", b.x, b.y);
await page.getByRole("button", { name: "Merge selected" }).click();
assert((await count()) === total - 1, "merged two shapes into one compound shape");
await page.getByRole("button", { name: "Break apart" }).click();
assert((await count()) === total && (await selCount()) === 2, "Break apart splits it back into its two pieces");
await page.getByRole("button", { name: "Undo" }).click();
await page.getByRole("button", { name: "Undo" }).click();
await page.keyboard.press("Escape");

// Node editing: select, Shift+select, box select, delete, smooth range, add point
const big = await pointOn(`${SHAPES}[fill="#1C4062"]`, 1);
await page.mouse.click(big.x, big.y);
const pts0 = parseInt(await page.getByTestId("point-count").innerText());
await page.getByRole("button", { name: "Edit nodes" }).click();
const info = () => page.getByTestId("node-info").innerText();
const nodes = page.locator('[data-testid="nodes"] .handle.node');
// Points whose handle is not covered by a neighbouring handle (dense points overlap at this zoom).
const freeNodes = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="nodes"] .handle.node')].flatMap((n) => {
    const r = n.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return document.elementFromPoint(x, y) === n ? [{ x, y }] : [];
  }));
assert(freeNodes.length >= 2, "found separate points to click");
await page.mouse.click(freeNodes[0].x, freeNodes[0].y);
assert((await info()).endsWith("1 selected"), "clicking a point selects it");
await clickWith("Shift", freeNodes[freeNodes.length - 1].x, freeNodes[freeNodes.length - 1].y);
assert((await info()).endsWith("2 selected"), "Shift+click adds a point");
await page.keyboard.press("Delete");
assert((await info()).startsWith(`${pts0 - 2} points`), "Delete removes the selected points");
await page.getByRole("button", { name: "Undo" }).click();
// Drag a box around a stretch of points, starting on empty canvas.
const boxPts = await page.evaluate(() => {
  const rs = [...document.querySelectorAll('[data-testid="nodes"] .handle.node')].slice(10, 22).map((n) => n.getBoundingClientRect());
  return { x0: Math.min(...rs.map((r) => r.left)), y0: Math.min(...rs.map((r) => r.top)), x1: Math.max(...rs.map((r) => r.right)), y1: Math.max(...rs.map((r) => r.bottom)) };
});
const start = await page.evaluate(([x, y]) => {
  for (let d = 6; d < 80; d += 4) for (const [dx, dy] of [[-d, -d], [d, -d], [-d, d]]) {
    const el = document.elementFromPoint(x + dx, y + dy);
    if (el?.classList.contains("node-catcher")) return [x + dx, y + dy];
  }
  return null;
}, [boxPts.x0, boxPts.y0]);
assert(start, "found empty canvas to start a box selection");
await page.mouse.move(start[0], start[1]);
await page.mouse.down();
await page.mouse.move(boxPts.x1 + 4, boxPts.y1 + 4, { steps: 6 });
await page.mouse.up();
const boxSel = parseInt((await info()).split("· ")[1]);
assert(boxSel >= 3, `dragging a box selects the points inside it (${boxSel})`);
const othersBefore = (await shapesNow()).filter((s) => s.id !== big.id).map((s) => s.d).join();
await page.screenshot({ path: join(out, "m55-nodes-selected.png") });
await page.getByLabel("Smooth selected points").fill("25");
await page.getByLabel("Smooth selected points").dispatchEvent("pointerup");
const ptsSmooth = parseInt(await info());
assert(ptsSmooth < pts0, `Smooth selected points simplifies that stretch (${pts0} -> ${ptsSmooth} points)`);
assert((await shapesNow()).filter((s) => s.id !== big.id).map((s) => s.d).join() === othersBefore, "other shapes are untouched");
await page.screenshot({ path: join(out, "m55-nodes-smoothed.png") });
// Double-click on the outline between points adds one.
const segPt = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="seg-hit"]');
  const len = p.getTotalLength(), m = p.getScreenCTM();
  for (let f = 0.05; f < 1; f += 0.013) {
    const q = p.getPointAtLength(len * f), x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
    if (document.elementFromPoint(x, y) === p) return { x, y };
  }
  return null;
});
await page.mouse.dblclick(segPt.x, segPt.y);
assert(parseInt(await info()) === ptsSmooth + 1, "double-clicking the outline adds a point");
await page.keyboard.press("Escape");

// Compare: hold C, release; click the button to lock, click again to unlock
const ab0 = await page.locator(".artboard").first().boundingBox();
await page.keyboard.down("c");
await page.getByTestId("compare-badge").waitFor({ timeout: 2000 });
assert((await page.locator('[data-pane="result"] .editor-layer').count()) === 0 && (await page.locator('[data-pane="result"] canvas').count()) === 1, "holding C shows the original instead of the result");
const ab1 = await page.locator(".artboard").first().boundingBox();
assert(Math.abs(ab0.x - ab1.x) < 0.5 && Math.abs(ab0.width - ab1.width) < 0.5, "at exactly the same zoom and position");
await page.screenshot({ path: join(out, "m55-compare.png") });
await page.keyboard.up("c");
assert((await page.getByTestId("compare-badge").count()) === 0, "releasing C returns to the result");
await page.getByRole("button", { name: "Compare" }).click();
assert((await page.getByTestId("compare-badge").count()) === 1, "a quick click on Compare keeps it on");
await page.getByRole("button", { name: "Compare" }).click();
assert((await page.getByTestId("compare-badge").count()) === 0, "a second click turns it off");

assert(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log("\nM5.5 test passed. Screenshots in tests/out/");
