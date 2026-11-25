import type { ScheduledMessage } from "../src/api/scheduledMessages";
import { test, expect, type Page } from "@playwright/test";

/** Browser tests mount real route components; every API request stays in this fixture. */
async function installFixture(page: Page) {
  const failures = new Set<string>();
  const writes: string[] = [];
  const errors: string[] = [];
  const tasks: ScheduledMessage[] = [];
  const delays = new Map<string, number>();
  page.on("pageerror", error => errors.push(error.message));
  let friends = [{ friendship_id: "friendship-1", friend_id: "lin", username: "lin", display_name: "Lin", status: "accepted" }];
  let delegates = [{ user_id: "lin", username: "lin", display_name: "Lin", channel_id: "channel-1", channel_name: "General", operation_kind: "*", granted_by: "owner", granted_at: "2026-11-13" }];
  let bot = { bot_id: "bot-1", username: "ada", display_name: "Ada", can_manage: true, is_online: true, description: "Saved description", status_text: "Ready", status_auto_update: false };
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    if (delays.has(path)) await new Promise(resolve => setTimeout(resolve, delays.get(path)));
    if (failures.has(path)) return route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } });
    let json: unknown;
    if (path === "/bots") json = [bot, { ...bot, bot_id: "bot-2", display_name: "Babbage" }];
    else if (/\/bots\/[^/]+\/social-policy$/.test(path)) json = { bot_id: path.split("/")[2], visibility: "public", friend_policy: "open", invite_policy: "require_approval" };
    else if (path === "/bots/bot-1/approvers") json = { owner_id: "preview-owner", delegates };
    else if (path === "/bots/bot-1/approvers/lin") { delegates = []; json = { ok: true }; }
    else if (path === "/bots/bot-1/permissions") json = { posture: { agent_type: "codex", permission_mode: null, allowed_modes: [] }, config_options: { advertised: [], desired: {} } };
    else if (path === "/bots/bot-1/event-access") json = { rules: [], effective: [], initiate_events: [], see_events: [], respond_events: [], groups: [] };
    else if (path === "/bots/bot-1/profile") { bot = { ...bot, ...request.postDataJSON() }; json = {}; }
    else if (path === "/fleet") json = { approvals: [], bots: [], summary: { online: 0, working: 0, offline: 0, waiting: 0 } };
    else if (path === "/fleet/audit" || path.endsWith("/permissions/audit")) json = { events: [] };
    else if (path === "/fleet/hosts" || path === "/bots/bot-1/hosts") json = { hosts: [] };
    else if (path === "/fleet/badge") json = { count: 0 };
    else if (path === "/friends") {
      if (request.method() === "DELETE") friends = [];
      json = friends;
    } else if (path === "/friends/block") { friends = []; json = { blocked: true }; }
    else if (path === "/friends/requests" || path.endsWith("/members") || path === "/channels" || path === "/workbench/extensions") json = [];
    else if (path === "/notifications") json = [{ id: "invite-1", kind: "workspace_invite", title: "Studio", workspace_id: "workspace-1", actor_name: "Lin", role: "member" }];
    else if (path === "/scheduled-messages") json = { tasks };
    else if (path.startsWith("/scheduled-messages/") && request.method() === "DELETE") {
      const index = tasks.findIndex(task => path === `/scheduled-messages/${task.id}`);
      if (index >= 0) tasks.splice(index, 1);
      json = { ok: true };
    }
    else if (path === "/admin/settings/stt") json = { configured: true, enabled: true, endpoint: "https://speech.example/v1", model: "whisper-1", api_key_set: false, api_key_hint: null };
    else if (path === "/admin/reports") json = [];
    else if (path === "/admin/settings/runtime") json = { settings: [{ key: "budget", label: "Request budget", description: "Maximum request budget", unit: "seconds", min: 1, max: 100, default_value: 30, override_value: null, effective_value: 30 }] };
    else if (path.endsWith("/revisions")) json = { revisions: [] };
    else if (path === "/workspaces" && request.method() === "POST") json = { workspace_id: "new", name: request.postDataJSON().name };
    else return route.abort();
    await route.fulfill({ json });
  });
  return { failures, writes, errors, tasks, delays };
}
const fixture = (route: string) => `/dev/page-structure.html?route=${encodeURIComponent(route)}`;

test("failed loads are retryable and dirty form dismissal preserves input", async ({ page }) => {
  const state = await installFixture(page);
  state.failures.add("/friends");
  await page.goto(fixture("/friends"));
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByText("No friends yet", { exact: true })).toHaveCount(0);
  state.failures.delete("/friends");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Remove friend", exact: true }).waitFor();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByLabel("Workspace name", { exact: true }).fill("My draft");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Workspace name", { exact: true })).toHaveValue("My draft");
  state.failures.add("/workspaces");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Temporarily unavailable");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("destructive actions wait for an explicit, readable confirmation on phones", async ({ page }) => {
  const state = await installFixture(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(fixture("/friends"));
  await page.getByRole("button", { name: "Remove friend", exact: true }).click();
  expect(state.writes).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Block", exact: true }).click();
  expect(state.writes).toEqual([]);
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText("No friends yet", { exact: true })).toBeVisible();
  expect(state.writes).toEqual(["POST /friends/block"]);
  await page.goto(fixture("/permissions?tab=operational"));
  await page.getByRole("button", { name: "Revoke delegation for Lin" }).click();
  const row = page.locator('[data-collection-mode="delete"]');
  await expect(row.getByText("Lin", { exact: true })).toBeVisible();
  await expect(row.getByText("This collaborator will no longer approve tools for this channel.", { exact: true })).toBeVisible();
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(state.writes).not.toContain("DELETE /bots/bot-1/approvers/lin");
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(state.writes).toContain("DELETE /bots/bot-1/approvers/lin");
  expect(state.errors).toEqual([]);
});

test("bot edit cancel restores saved fields and failed save keeps the draft", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(fixture("/fleet/bots/bot-1/overview"));
  const dialog = page.getByRole("dialog", { name: "Ada — Bot details" });
  await dialog.getByRole("button", { name: "Edit bot profile", exact: true }).click();
  await dialog.getByLabel("Bot description", { exact: true }).fill("Unsaved draft");
  await dialog.getByRole("button", { name: "Close bot details", exact: true }).click();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await dialog.getByRole("button", { name: "Cancel editing bot profile", exact: true }).click();
  expect(state.writes).toEqual([]);
  await dialog.getByRole("button", { name: "Edit bot profile", exact: true }).click();
  await expect(dialog.getByLabel("Bot description", { exact: true })).toHaveValue("Saved description");
  await dialog.getByLabel("Bot description", { exact: true }).fill("New description");
  state.failures.add("/bots/bot-1/profile");
  await dialog.getByRole("button", { name: "Save bot profile", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(dialog.getByLabel("Bot description", { exact: true })).toHaveValue("New description");
  state.failures.clear();
  await dialog.getByRole("button", { name: "Save bot profile", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit bot profile", exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("Activity page and dialog share the invitation view, and audit failure is not empty success", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(fixture("/activity"));
  await expect(page.getByRole("main").getByText("Workspace invite · Studio · from Lin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Activity dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Activity", exact: true }).getByText("Workspace invite · Studio · from Lin", { exact: true })).toBeVisible();
  state.failures.add("/channels/channel-1/permissions/audit");
  await page.goto(fixture("/audit"));
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByText("No permission decisions yet", { exact: true })).toHaveCount(0);
  state.failures.clear();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No permission decisions yet", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});


test("permission drafts survive section and bot switching, and cancel resets them", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(fixture("/permissions"));
  await page.getByRole("button", { name: "Edit social policy", exact: true }).click();
  await page.getByRole("radio", { name: "Private", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Permission sections" });
  await nav.getByRole("button", { name: "Operational", exact: true }).click();
  await nav.getByRole("button", { name: "Social", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Private", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("Bot", { exact: true }).selectOption("bot-2");
  await page.getByRole("button", { name: "Edit social policy", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Public", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("Bot", { exact: true }).selectOption("bot-1");
  await expect(page.getByRole("radio", { name: "Private", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Cancel editing social policy", exact: true }).click();
  await page.getByRole("button", { name: "Edit social policy", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Public", exact: true })).toHaveAttribute("aria-checked", "true");
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("admin loads fail closed, retry restores saved settings, and history has its own error", async ({ page }) => {
  const state = await installFixture(page);
  state.failures.add("/admin/settings/stt");
  await page.goto(fixture("/settings/speech"));
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByRole("button", { name: "Save speech-to-text settings", exact: true })).toHaveCount(0);
  state.failures.clear();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue("https://speech.example/v1");
  expect(state.writes).toEqual([]);
  for (const [route, path, empty] of [["/settings/reports", "/admin/reports", "No reports"], ["/settings/scheduled", "/scheduled-messages", "No scheduled tasks"], ["/settings/runtime", "/admin/settings/runtime", "No changes yet"]]) {
    state.failures.add(path);
    await page.goto(fixture(route));
    await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
    state.failures.delete(path);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  state.failures.add("/admin/settings/runtime/budget/revisions");
  await page.goto(fixture("/settings/runtime"));
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByText("Loading change history…", { exact: true })).toHaveCount(0);
  state.failures.clear();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No changes yet", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("scheduled deletion rejects repeated submission and keeps a failed confirmation retryable", async ({ page }) => {
  const state = await installFixture(page);
  state.tasks.push({ id: "task-1", title: "Daily review", channelId: "channel-1", channelName: "General", content: "Review the changes", mentionIds: [], schedule: { kind: "daily", localTime: "09:00", timezone: "UTC" }, enabled: true, consecutiveFailures: 0, retryAttempt: 0, createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" });
  state.failures.add("/scheduled-messages/task-1");
  state.delays.set("/scheduled-messages/task-1", 300);
  await page.goto(fixture("/settings/scheduled"));
  await page.getByRole("button", { name: "Delete Daily review", exact: true }).click();
  const confirmation = page.locator('[data-collection-mode="delete"]');
  const remove = confirmation.getByRole("button", { name: "Delete", exact: true });
  await remove.evaluate(button => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button"); button.click(); button.click(); });
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  expect(state.writes.filter(write => write === "DELETE /scheduled-messages/task-1")).toHaveLength(1);
  await expect(confirmation.getByText("Daily review", { exact: true })).toBeVisible();
  await expect(remove).toBeEnabled();
  state.failures.clear();
  await remove.click();
  await expect(page.getByText("No scheduled tasks", { exact: true })).toBeVisible();
  expect(state.writes.filter(write => write === "DELETE /scheduled-messages/task-1")).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test("provider fields expose their visible labels through nested shared controls", async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(fixture("/fleet/bots/bot-1/overview"));
  const dialog = page.getByRole("dialog", { name: "Ada — Bot details" });
  await dialog.getByRole("button", { name: "Edit bot profile", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Sends channel data to an external AI provider", exact: true }).focus();
  await page.keyboard.press("Space");
  await dialog.getByLabel("Provider name", { exact: true }).fill("Example AI");
  await dialog.getByLabel("Provider privacy URL", { exact: true }).fill("https://provider.example/privacy");
  await dialog.getByLabel("Data use shown to members", { exact: true }).fill("Selected messages are processed to answer requests.");
  await expect(dialog.getByLabel("Disclosure version", { exact: true })).toHaveValue("1");
  expect(state.errors).toEqual([]);
});

test("personal extension uninstall waits for confirmation and preserves disabled state on failure", async ({ page }) => {
  await page.route("**/api/v1/workbench/extensions", route => route.fulfill({ json: [] }));
  await page.route("https://haowei2000.github.io/Cheers/extensions/catalog.json", route => route.fulfill({ json: { schemaVersion: 1, publisher: "Preview", entries: [] } }));
  await page.goto("/dev/extension-manager.html");
  await page.getByRole("button", { name: "Uninstall Preview Notes", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, "workbenchPreview").removeCalls)).toBe(0);
  const confirmation = page.locator('[data-collection-mode="delete"]');
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Uninstall Preview Notes", exact: true }).click();
  await confirmation.getByRole("button", { name: "Remove", exact: true }).evaluate(button => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button"); button.click(); button.click(); });
  await expect(page.getByRole("alert")).toContainText("The package could not be removed");
  expect(await page.evaluate(() => Reflect.get(window, "workbenchPreview").removeCalls)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("cheers.workbench.disabled-personal-extensions"))).toContain("preview-notes");
  await page.evaluate(() => { Reflect.get(window, "workbenchPreview").failUninstall = false; });
  await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByText("No extensions installed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "workbenchPreview").removeCalls)).toBe(2);
});
