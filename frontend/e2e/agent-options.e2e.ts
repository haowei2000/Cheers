import { test, expect, type Page } from "@playwright/test";

// Browser coverage for the actual hooks and controls using the isolated local
// fixture. Real authenticated WS -> HTTP projection is covered separately by
// server/tests/connector_options_http.rs; no installed agent is involved here.
function fixture(scenario: string, theme = "light") {
  return `/dev/agent-options.html?frame=1&case=${scenario}&theme=${theme}`;
}

test("mounted settings and model label recover from an initially empty advertisement", async ({ page }) => {
  await page.goto(fixture("discovery"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("No agent options available yet.", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);

  // No reload, focus change, or explicit refresh: the existing observers must
  // discover the later catalogue and keep default/session values distinct.
  const model = page.getByRole("button", { name: "Model and bot settings: GPT-5 fast", exact: true });
  await expect(model).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-default");
  await model.click();
  const dialog = page.getByRole("dialog", { name: "Model and bot settings" });
  const sessionModel = dialog.getByRole("combobox", { name: "Model for @hwcodex", exact: true });
  await expect(sessionModel).toHaveValue("gpt-session");
  await sessionModel.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(model).toBeFocused();

  await page.getByRole("button", { name: /^Pinned to @hwcodex/ }).click();
  await page.getByRole("option", { name: "Auto · @mention → primary", exact: true }).click();
  await expect(page.getByRole("button", { name: "Model and bot settings: GPT-5", exact: true })).toBeVisible();
  await expect(page.getByText("Direct · mentions off", { exact: true })).toHaveCount(0);
});

test("failed options are visible and retryable in both settings surfaces", async ({ page }) => {
  await page.goto(fixture("error"), { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("Could not load agent options");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gpt-default");
  await page.getByRole("button", { name: /^Model and bot settings:/ }).click();
  await expect(page.getByRole("dialog", { name: "Model and bot settings" })
    .getByRole("combobox", { name: "Model for @hwcodex", exact: true })).toHaveValue("gpt-session");
});

async function checkLayout(page: Page, width: number, touch = false) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const model = page.getByRole("button", { name: /^Model and bot settings:/ });
  const session = page.getByRole("button", { name: /^Pinned to @/ });
  await session.scrollIntoViewIfNeeded();
  await model.scrollIntoViewIfNeeded();
  for (const control of [model, session]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(96, 0);
    expect(box!.height).toBeGreaterThanOrEqual(touch ? 44 : 36);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await expect(control).not.toHaveAttribute("data-selected", "true");
  }
  const boxes = await Promise.all([model.boundingBox(), session.boundingBox()]);
  const [a, b] = boxes as [NonNullable<typeof boxes[0]>, NonNullable<typeof boxes[0]>];
  expect(a.x + a.width <= b.x || b.x + b.width <= a.x ||
    a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(page.getByText("Direct · mentions off", { exact: true })).toBeVisible();
}

test("pinned composer stays aligned in both themes, narrow layouts, and 200% equivalent zoom", async ({ browser, baseURL }, info) => {
  test.setTimeout(90_000);
  for (const theme of ["light", "dark"] as const) {
    for (const [scenario, width, scale] of [
      ["ready", 390, 1], ["ready", 768, 1], ["ready", 1280, 1],
      ["long", 390, 1], ["long", 640, 2],
    ] as const) {
      const context = await browser.newContext({
        baseURL, viewport: { width, height: 1000 / scale }, deviceScaleFactor: scale,
        isMobile: width === 390, hasTouch: width === 390,
        colorScheme: theme, serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(fixture(scenario, theme), { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("button", {
          name: scenario === "long"
            ? "Model and bot settings: A very long discovered model name with reasoning"
            : "Model and bot settings: GPT-5 fast",
          exact: true,
        })).toBeVisible();
        await checkLayout(page, width, width === 390);
        await page.screenshot({ path: info.outputPath(`${theme}-${scenario}-${width}-${scale}x.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }
});
