#!/usr/bin/env node
/** @file
 * Retake the website's product screenshots from a running Cheers stack.
 *
 * Signs in, seeds a small demo workspace through the public API, then opens
 * every shot in `scripts/lib/website-shots.mjs` in the light and dark themes
 * and writes `website/imgs/<name>-<theme>.png` at 2x. Needs only Node 22+
 * (for its built-in WebSocket) and a local Chrome; there is nothing to install.
 *
 *   node scripts/capture-website-screenshots.mjs [options]
 *
 *   --base-url <url>   Cheers web origin (env CHEERS_BASE_URL, default http://localhost:30080)
 *   --only <a,b>       capture only these shots
 *   --theme <name>     capture one theme (light or dark)
 *   --skip-seed        use the demo workspace as it is
 *   --headed           show the browser window
 *
 * Environment: CHEERS_LOGIN / CHEERS_PASSWORD (default: the local stack's
 * admin), CHEERS_DEMO_BOT (name or id of the bot that answers the demo
 * prompt; default: the first online bot), CHROME_PATH.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchChrome, sleep } from "./lib/cdp-browser.mjs";
import { DEMO, outputPath, selectShots, selectThemes } from "./lib/website-shots.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPLY_TIMEOUT_MS = 10 * 60_000;

const { values: options } = parseArgs({
  options: {
    "base-url": { type: "string" },
    only: { type: "string" },
    theme: { type: "string" },
    "skip-seed": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (options.help) {
  console.log("Usage: node scripts/capture-website-screenshots.mjs [--base-url URL] [--only a,b] [--theme light|dark] [--skip-seed] [--headed]");
  process.exit(0);
}

const BASE_URL = (options["base-url"] ?? process.env.CHEERS_BASE_URL ?? "http://localhost:30080").replace(/\/$/, "");
const LOGIN = process.env.CHEERS_LOGIN ?? "admin";
const PASSWORD = process.env.CHEERS_PASSWORD ?? "admin12345";
const shots = selectShots(options.only);
const themes = selectThemes(options.theme);

// ── Public API client (Bearer token; the browser gets its own cookie session) ──

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== "authenticated" || !body.access_token) {
    throw new Error(`Sign-in as ${LOGIN} failed (${response.status} ${body.status ?? ""}). Check CHEERS_LOGIN / CHEERS_PASSWORD; accounts with two-step verification are not supported.`);
  }
  return body.access_token;
}

function apiClient(token) {
  const call = async (method, path, body) => {
    const response = await fetch(`${BASE_URL}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
  };
}

// ── Demo data (idempotent: everything is found by name before it is created) ──

async function seedDemo(api, { create }) {
  let workspace = (await api.get("/workspaces")).find((item) => item.name === DEMO.workspace);
  if (!workspace && !create) throw new Error(`Demo workspace "${DEMO.workspace}" not found; run without --skip-seed once.`);
  workspace ??= await api.post("/workspaces", { name: DEMO.workspace });

  const channels = await api.get(`/channels?workspace_id=${encodeURIComponent(workspace.id)}`);
  let channel = channels.find((item) => item.name === DEMO.channel);
  if (!channel && !create) throw new Error(`Demo channel "${DEMO.channel}" not found; run without --skip-seed once.`);
  channel ??= await api.post("/channels", { workspace_id: workspace.id, name: DEMO.channel, purpose: DEMO.purpose });

  const bot = await pickBot(api);
  if (bot && create) await ensureBotMember(api, channel.id, bot.id);

  let messages = await listMessages(api, channel.id);
  if (create && !messages.some((message) => message.sender_type === "user")) {
    for (const content of DEMO.messages) await api.post(`/channels/${channel.id}/messages`, { content });
  }
  if (create && bot && !messages.some((message) => message.sender_type === "bot")) {
    await api.post(`/channels/${channel.id}/messages`, {
      content: `<@bot:${bot.id}> ${DEMO.prompt}`,
      mention_ids: [bot.id],
    });
    console.log(`Asked ${bot.name ?? bot.id} for the demo reply; waiting for it to finish…`);
    await waitForBotReply(api, channel.id);
  }
  messages = await listMessages(api, channel.id);
  return { workspace, channel, bot, hasBotReply: messages.some((message) => message.sender_type === "bot" && !message.is_partial) };
}

/** Bot records name their id `bot_id` or `id` depending on the endpoint. */
function normalizeBot(raw) {
  return { ...raw, id: raw.bot_id ?? raw.id, name: raw.name ?? raw.display_name ?? raw.username };
}

async function pickBot(api) {
  const bots = (await api.get("/bots")).map(normalizeBot);
  const wanted = process.env.CHEERS_DEMO_BOT;
  if (wanted) {
    const bot = bots.find((item) => item.id === wanted || item.name === wanted);
    if (!bot) throw new Error(`CHEERS_DEMO_BOT "${wanted}" is not one of: ${bots.map((item) => item.name).join(", ")}`);
    return bot;
  }
  // `status` is a persisted flag that stays "online"; `is_online` is the live connection.
  return bots.find((item) => item.is_online === true) ?? null;
}

async function ensureBotMember(api, channelId, botId) {
  const members = await api.get(`/channels/${channelId}/members`);
  const list = Array.isArray(members) ? members : (members.members ?? []);
  if (list.some((member) => (member.member_id ?? member.id) === botId)) return;
  await api.post(`/channels/${channelId}/members`, { member_id: botId, member_type: "bot" });
}

async function listMessages(api, channelId) {
  const page = await api.get(`/channels/${channelId}/messages?limit=100`);
  return Array.isArray(page) ? page : (page.messages ?? []);
}

async function waitForBotReply(api, channelId) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const messages = await listMessages(api, channelId);
    if (messages.some((message) => message.sender_type === "bot" && !message.is_partial)) return;
    await sleep(3000);
  }
  throw new Error("The demo bot did not finish replying within 10 minutes; is its connector online?");
}

// ── Browser: sign in once, then pin the theme and freeze motion on every load ──

const FREEZE_CSS = [
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  "::-webkit-scrollbar { display: none !important; }",
].join("\n");

function themeInitScript(theme) {
  return `(() => {
    try { localStorage.setItem("cheers.theme", ${JSON.stringify(theme)}); } catch {}
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(FREEZE_CSS)};
    const mount = () => document.head && document.head.appendChild(style);
    if (!mount()) document.addEventListener("DOMContentLoaded", mount, { once: true });
  })();`;
}

async function signInBrowser(page) {
  await page.goto(`${BASE_URL}/login`);
  const status = await page.evaluate(async (login, password) => {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login, password }),
    });
    return response.status;
  }, LOGIN, PASSWORD);
  if (status !== 200) throw new Error(`Browser sign-in failed with HTTP ${status}`);
}

// ── In-page locators (serialized into the page, so they take arguments, never closures) ──

/** A button, tab, or link whose accessible name or text starts with `name`. */
function findControl(name) {
  const wanted = name.toLowerCase();
  const label = (element) =>
    (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "").trim().toLowerCase();
  return [...document.querySelectorAll('button, [role="button"], [role="tab"], a')]
    .filter((element) => element.getClientRects().length > 0)
    .find((element) => label(element).startsWith(wanted)) ?? null;
}

function boxOf(selector, padding) {
  const element = document.querySelector(selector);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const x = Math.max(0, box.left - padding);
  const y = Math.max(0, box.top - padding);
  return {
    x,
    y,
    width: Math.min(innerWidth - x, box.width + padding * 2),
    height: Math.min(innerHeight - y, box.height + padding * 2),
  };
}

// ── Views, preparation steps, and capture regions named in the shot list ──

const VIEWS = {
  channel: ({ demo }) => `/chat/${demo.workspace.id}/${demo.channel.id}`,
  botDetail: ({ demo }) => (demo.bot ? `/fleet/bots/${demo.bot.id}/permissions` : "/fleet/bots"),
};

const STEPS = {
  async openViewBoard(page) {
    await page.click(findControl, ["ViewBoard"], { what: "the ViewBoard toggle" });
    await page.waitFor(() => document.querySelector('[aria-label="ViewBoard sections"]'), [], { what: "the ViewBoard drawer" });
  },
  async selectViewBoardAudit(page) {
    await page.click(findControl, ["Audit"], { what: "the ViewBoard Audit tab" });
  },
  async openWorkbench(page) {
    await page.click(findControl, ["Workbench"], { what: "the Workbench toggle" });
  },
  async openModelPopover(page) {
    await page.click(findControl, ["Model and bot settings"], { what: "the composer model button" });
  },
  async expandLatestTrace(page) {
    await page.click(
      () => [...document.querySelectorAll('button[aria-expanded="false"]')].filter((element) => /^Show details for /.test(element.getAttribute("aria-label") ?? "")).at(-1) ?? null,
      [],
      { what: "an Agent steps row" },
    );
  },
  async closeDrawers(page) {
    await page.press("Escape");
  },
  async scrollToGrants(page) {
    await page.waitFor(() => {
      const heading = [...document.querySelectorAll("h2, h3")].find((element) => /permission/i.test(element.textContent ?? ""));
      heading?.scrollIntoView({ block: "start" });
      return Boolean(heading);
    }, [], { what: "the permission grants section" });
  },
};

const CAPTURES = {
  viewport: () => null,
  viewBoardDrawer: (page) => page.waitFor(boxOf, ['[aria-label="ViewBoard sections"]', 0], { what: "the ViewBoard drawer box" }),
  workbenchDrawer: (page) => page.waitFor(boxOf, ['[title="Workbench"]', 0], { what: "the Workbench drawer box" }),
  composerWithPopover: (page) => page.waitFor(boxOf, ['[role="dialog"], [role="menu"]', 24], { what: "the model popover" }),
  grantsSection: (page) => page.waitFor(boxOf, ['section:has(h2), section:has(h3)', 16], { what: "the grants section box" }),
};

async function captureShot(browser, shot, theme, demo) {
  const page = await browser.newPage();
  try {
    await page.setViewport(shot.viewport);
    await page.setColorScheme(theme);
    await page.addInitScript(themeInitScript(theme));
    await page.goto(`${BASE_URL}${VIEWS[shot.view]({ demo })}`);
    await page.waitFor(() => document.fonts.status === "loaded" && !document.querySelector('input[type="password"]'), [], { what: "the signed-in app shell" });
    await sleep(1500);
    for (const step of shot.prepare) {
      await STEPS[step](page);
      await sleep(600);
    }
    const clip = await CAPTURES[shot.capture](page);
    const file = resolve(ROOT, outputPath(shot.name, theme));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await page.screenshot(clip ?? undefined));
    return file;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Run ──

const api = apiClient(await signIn());
const demo = await seedDemo(api, { create: !options["skip-seed"] });
console.log(`Demo: ${DEMO.workspace} / #${DEMO.channel}${demo.bot ? ` with ${demo.bot.name ?? demo.bot.id}` : " (no bot)"}`);

const browser = await launchChrome({ headless: !options.headed });
const written = [];
const skipped = [];
try {
  const session = await browser.newPage();
  await signInBrowser(session);
  await session.close();
  for (const theme of themes) {
    for (const shot of shots) {
      if (shot.needsBotReply && !demo.hasBotReply) {
        skipped.push(`${shot.name}-${theme}: needs a bot reply in #${DEMO.channel} (set CHEERS_DEMO_BOT to an online bot)`);
        continue;
      }
      try {
        written.push(await captureShot(browser, shot, theme, demo));
        console.log(`✓ ${shot.name} (${theme})`);
      } catch (error) {
        skipped.push(`${shot.name}-${theme}: ${error.message}`);
        console.log(`✗ ${shot.name} (${theme}): ${error.message}`);
      }
    }
  }
} finally {
  await browser.close();
}

console.log(`\nWrote ${written.length} screenshot(s) to ${outputPath("<name>", themes[0]).replace(/<name>.*$/, "")}`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length}:\n  ${skipped.join("\n  ")}`);
  process.exitCode = 1;
}
