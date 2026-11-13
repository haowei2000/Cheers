import { test, expect, type Page } from "@playwright/test";

/** Browser tests mount real route components; every API request stays in this fixture. */
async function installFixture(page: Page) {
  const failures = new Set<string>();
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let friends = [{ friendship_id: "friendship-1", friend_id: "lin", username: "lin", display_name: "Lin", status: "accepted" }];
  let delegates = [{ user_id: "lin", username: "lin", display_name: "Lin", channel_id: "channel-1", channel_name: "General", operation_kind: "*", granted_by: "owner", granted_at: "2026-11-13" }];
  let bot = { bot_id: "bot-1", username: "ada", display_name: "Ada", can_manage: true, is_online: true, description: "Saved description", status_text: "Ready", status_auto_update: false };
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    if (failures.has(path)) return route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } });
    let json: unknown;
    if (path === "/bots") json = [bot];
    else if (path === "/bots/bot-1/social-policy") json = { bot_id: "bot-1", visibility: "public", friend_policy: "open", invite_policy: "require_approval" };
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
    else if (path === "/scheduled-messages") json = { tasks: [] };
    else if (path === "/workspaces" && request.method() === "POST") json = { workspace_id: "new", name: request.postDataJSON().name };
    else return route.abort();
    await route.fulfill({ json });
  });
  return { failures, writes, errors };
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
