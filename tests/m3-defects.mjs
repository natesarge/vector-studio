// Checks "Clean defects" on a rougher image (tribe.png) at several sizes.
// Run with the dev server up:  node tests/m3-defects.mjs [url]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const url = process.argv[2] ?? "http://localhost:5173/";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
await page.goto(url);
await page.locator('header input[type="file"]').setInputFiles(join(here, "..", "reference", "images", "tribe.png"));
await page.getByLabel("Snap to palette").check();
await page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 180000 });
await page.getByLabel("Speckle removal").fill("4"); // keep small specks so there is something to clean
await page.waitForSelector('[data-testid="status"][data-status="busy"]');
await page.waitForSelector('[data-testid="status"][data-status="done"]', { timeout: 180000 });
await page.getByRole("radio", { name: "Result", exact: true }).click();
await page.getByLabel("Shapes", { exact: true }).check();

const count = () => page.locator(".editor-layer path[data-shape-id]").count();
console.log("shapes before:", await count());
await page.screenshot({ path: join(out, "m3-defects-before.png") });
for (const size of [8, 20]) {
  await page.getByLabel("Defect size").fill(String(size));
  await page.getByRole("button", { name: "Clean defects" }).click();
  console.log(`size ${size}: ${await page.getByTestId("edit-note").innerText()} -> ${await count()} shapes`);
  await page.screenshot({ path: join(out, `m3-defects-${size}.png`) });
}
await browser.close();
