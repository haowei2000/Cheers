// Minimal verified driver for the Cheers chat UI (playwright-core + system Chrome).
// Run from the temp dir where playwright-core is installed: `node driver.mjs`.
// Adapt the "flow under test" section; keep the login block as-is.
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL || "http://localhost:5173";
const CHANNEL = process.env.E2E_CHANNEL || "claude-smoke";
const OUT = process.cwd();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 950 } })
).newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});

// ── Login (see SKILL.md gotchas: async /login redirect; field is `login`) ──
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
const pw = page.locator('input[type="password"]');
await pw.waitFor({ timeout: 15000 }).catch(() => {});
if (await pw.count()) {
  await page.locator('input[type="text"]').first().fill("admin");
  await pw.fill("admin12345");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/auth/login"), { timeout: 15000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  console.log("login status:", resp.status());
}
await page.waitForTimeout(3000); // chat shell + sidebar hydrate

// ── Open a channel by NAME (generic selectors hit the wrong buttons) ──
await page.getByText(CHANNEL, { exact: true }).first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/01-channel.png` });

// ── Flow under test (example: ViewBoard normal + minimal) ──
// Persisted UI state: close the drawer if it restored open, then reopen fresh.
const closeBtn = page.locator('aside button[title="Close"]');
if (await closeBtn.count()) await closeBtn.first().click().catch(() => {});
await page.locator('button[title^="ViewBoard"]').first().click();
await page.waitForTimeout(2000);
const expandBtn = page.locator('button[title="Expand"]');
if (await expandBtn.count()) {
  await expandBtn.click(); // restored in minimal mode — normalize to expanded
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: `${OUT}/02-viewboard-normal.png` });
await page.locator('button[title="Minimize"]').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/03-viewboard-minimal.png` });

console.log("done — screenshots in", OUT);
await browser.close();
