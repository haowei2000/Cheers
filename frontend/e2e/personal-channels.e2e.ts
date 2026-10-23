import { expect, test, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "node:process";
import { stripVTControlCharacters } from "node:util";

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required by the isolated E2E fixture`);
  return value;
}

function apiResponse(response: Response, path: string, method: string): boolean {
  return new URL(response.url()).pathname === `/api/v1${path}` &&
    response.request().method() === method;
}

// Read only a new dev-delivery block addressed to this test's unique mailbox.
// The actual request-code endpoint generates and hashes the proof; no DB writes
// or authentication overrides are performed by the browser test.
function registrationCode(log: string, email: string): string | undefined {
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const recipient = new RegExp(`\\bto="?${escapedEmail}"?(?:\\s|$)`);
  const marker = "email (dev delivery via log — set BREVO_API_KEY + EMAIL_FROM_EMAIL for real email):";
  const blocks = stripVTControlCharacters(log).split(marker).slice(1).reverse();
  for (const block of blocks) {
    if (!recipient.test(block) || !block.includes("Enter this code to finish creating your account:")) continue;
    const code = block.match(/^\s{4}([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\s*$/m)?.[1];
    if (code) return code;
  }
}

async function createAndReloadChannel(
  page: Page,
  workspaceId: string,
  visibility: "public" | "private",
): Promise<{ channel_id: string; name: string; type: string }> {
  const name = `e2e-${visibility}-${randomUUID().slice(0, 12)}`;
  await page.getByRole("button", { name: "New channel", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Channel name", exact: true }).fill(name);

  const choices = dialog.getByRole("radiogroup", { name: "Channel visibility", exact: true });
  // Public is the actual default that exposed the Personal membership bug.
  await expect(choices.getByRole("radio", { name: "Public", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  if (visibility === "private") {
    await choices.getByRole("radio", { name: "Private", exact: true }).click();
  }
  await expect(choices.getByRole("radio", { name: visibility === "public" ? "Public" : "Private", exact: true }))
    .toHaveAttribute("aria-checked", "true");

  const [response] = await Promise.all([
    page.waitForResponse((item) => apiResponse(item, "/channels", "POST")),
    dialog.getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  expect(response.ok(), `The real ${visibility} channel creation returned HTTP ${response.status()}`)
    .toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    workspace_id: workspaceId,
    name,
    type: visibility,
  });
  const channel: { channel_id: string; name: string; type: string } = await response.json();
  expect(channel).toMatchObject({ name, type: visibility, workspace_id: workspaceId });
  expect(channel.channel_id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL((url) => url.pathname === `/chat/${workspaceId}/${channel.channel_id}`);
  await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "page");

  const [listResponse] = await Promise.all([
    page.waitForResponse((item) => apiResponse(item, "/channels", "GET") &&
      new URL(item.url()).searchParams.get("workspace_id") === workspaceId),
    page.reload(),
  ]);
  expect(listResponse.ok(), "Reload must read the persisted channel list from the gateway").toBe(true);
  expect(await listResponse.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ channel_id: channel.channel_id, workspace_id: workspaceId, name, type: visibility }),
  ]));
  await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL((url) => url.pathname === `/chat/${workspaceId}/${channel.channel_id}`);
  return channel;
}

test("an ordinary user registers, signs in, and creates persisted Public and Private channels in Personal", async ({ page }) => {
  const username = required("E2E_USER_LOGIN");
  const password = required("E2E_USER_PASSWORD");
  const email = required("E2E_USER_EMAIL").trim().toLowerCase();
  const gatewayLog = required("CHEERS_E2E_GATEWAY_LOG");

  await page.goto("/register");
  await page.getByRole("textbox", { name: "Username", exact: true }).fill(username);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  const logOffset = (await readFile(gatewayLog, "utf8")).length;
  const [codeResponse] = await Promise.all([
    page.waitForResponse((item) => apiResponse(item, "/auth/register/request-code", "POST")),
    page.getByRole("button", { name: "Send code", exact: true }).click(),
  ]);
  expect(codeResponse.ok(), `Real email-code request returned HTTP ${codeResponse.status()}`).toBe(true);
  let code: string | undefined;
  await expect.poll(async () => {
    code = registrationCode((await readFile(gatewayLog, "utf8")).slice(logOffset), email);
    return Boolean(code);
  }, { message: "The isolated gateway must deliver a registration code to this test mailbox" }).toBe(true);
  if (!code) throw new Error("The isolated registration email was not delivered");
  await page.getByRole("textbox", { name: "Verification code", exact: true }).fill(code);

  const [registrationResponse] = await Promise.all([
    page.waitForResponse((item) => apiResponse(item, "/auth/register", "POST")),
    page.getByRole("button", { name: "Create account", exact: true }).click(),
  ]);
  expect(registrationResponse.ok(), `Real registration returned HTTP ${registrationResponse.status()}`).toBe(true);
  const registered: { user_id: string; role: string } = await registrationResponse.json();
  expect(registered.role, "The scenario must not be masked by a platform-admin bypass").toBe("member");
  expect(registered.user_id).toMatch(/^[0-9a-f-]{36}$/i);
  if (env.E2E_USER_ID) expect(registered.user_id).toBe(env.E2E_USER_ID);
  await expect(page.getByTitle("Personal (DMs / personal space)", { exact: true })).toBeEnabled();

  const [logoutResponse] = await Promise.all([
    page.waitForResponse((item) => apiResponse(item, "/auth/logout", "POST")),
    page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  expect(logoutResponse.ok()).toBe(true);
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await page.getByRole("textbox", { name: "Username or Email", exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [loginResponse, personalResponse] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === "POST" &&
      /^\/api\/v1\/auth\/flows\/[^/]+\/password$/.test(new URL(item.url()).pathname)),
    page.waitForResponse((item) => apiResponse(item, "/workspaces/personal", "GET")),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  expect(loginResponse.ok()).toBe(true);
  const signedIn: { user_id: string; role: string; access_token: string } = await loginResponse.json();
  expect(signedIn.user_id).toBe(registered.user_id);
  expect(signedIn.role).toBe("member");
  expect(Boolean(signedIn.access_token)).toBe(true);
  // Verify the authority from the authenticated gateway, not a decoded token or UI label.
  const profileResponse = await page.request.get("/api/v1/users/me", {
    headers: { Authorization: `Bearer ${signedIn.access_token}` },
  });
  expect(profileResponse.ok()).toBe(true);
  expect(await profileResponse.json()).toMatchObject({ user_id: registered.user_id, username, role: "member" });
  expect(personalResponse.ok()).toBe(true);
  const personal: { workspace_id: string; kind: string } = await personalResponse.json();
  expect(personal.kind).toBe("personal");
  expect(personal.workspace_id).toMatch(/^[0-9a-f-]{36}$/i);
  await page.getByTitle("Personal (DMs / personal space)", { exact: true }).click();
  await expect(page.getByRole("separator", { name: "Direct messages", exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === `/chat/${personal.workspace_id}`);

  const channels = [];
  for (const visibility of ["public", "private"] as const) {
    channels.push(await test.step(`Create and reload a ${visibility} Personal channel`, () =>
      createAndReloadChannel(page, personal.workspace_id, visibility)));
  }
  // Reloading after Private creation must retain both independently persisted channels.
  for (const channel of channels) {
    await expect(page.getByRole("button", { name: channel.name, exact: true })).toBeVisible();
  }
});
