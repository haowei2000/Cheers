/** @file
 * The website's product screenshots: what to seed, which views to open, and
 * where each capture lands. `scripts/capture-website-screenshots.mjs` drives
 * a running Cheers stack through this list in both themes.
 */

export const THEMES = ["light", "dark"];

/** Captures land here as `<name>-<theme>.png`; the website and READMEs read them. */
export const OUTPUT_DIR = "website/imgs";

/** Demo content seeded through the public API. Seeding is idempotent by name. */
export const DEMO = {
  workspace: "Cheers Demo",
  channel: "launch-plan",
  purpose: "Ship the 0.2 launch: checklist, docs, and release notes.",
  messages: [
    "Kicking off the 0.2 launch here. The checklist lives in the Workbench board; let's keep decisions in this channel.",
    "Docs are drafted. Release notes still need the connector changes and the new theme.",
  ],
  /** Sent to the demo bot with a mention; its reply fills the agent views. */
  prompt:
    "Please read the launch board, list what is still open, and draft three release-note bullets for the new theme and the architecture map.",
};

/**
 * Each shot opens `view`, runs its `prepare` steps, then captures `capture`:
 * a CSS selector (captured as the element box) or "viewport". `viewport` is
 * the CSS size of the window; every capture is taken at a 2x device ratio.
 */
export const SHOTS = [
  {
    name: "hero-chat",
    alt: "Cheers channel where a teammate mentions an AI agent; the agent replies inline while ViewBoard tracks the work.",
    viewport: { width: 1600, height: 900 },
    view: "channel",
    prepare: ["openViewBoard"],
    capture: "viewport",
    needsBotReply: true,
  },
  {
    name: "chat",
    alt: "Channel chat with a user mentioning a bot and the expanded Agent steps trace.",
    viewport: { width: 1280, height: 820 },
    view: "channel",
    prepare: ["closeDrawers", "expandLatestTrace"],
    capture: "viewport",
    needsBotReply: true,
  },
  {
    name: "agentconfig",
    alt: "Composer model popover with mode, model, reasoning effort, and fast mode.",
    viewport: { width: 1280, height: 820 },
    view: "channel",
    prepare: ["closeDrawers", "openModelPopover"],
    capture: "composerWithPopover",
    needsBotReply: false,
  },
  {
    name: "viewboard",
    alt: "ViewBoard Audit tab listing agent commands with their approval decisions.",
    viewport: { width: 1440, height: 900 },
    view: "channel",
    prepare: ["openViewBoard", "selectViewBoardAudit"],
    capture: "viewBoardDrawer",
    needsBotReply: true,
  },
  {
    name: "workbench",
    alt: "Workbench with the file tree and a kanban board rendered from the launch plan.",
    viewport: { width: 1440, height: 900 },
    view: "channel",
    prepare: ["openWorkbench"],
    capture: "workbenchDrawer",
    needsBotReply: false,
  },
  {
    name: "grant",
    alt: "Permission grants matrix for bot actions across channel roles.",
    viewport: { width: 1280, height: 900 },
    view: "botDetail",
    prepare: ["scrollToGrants"],
    capture: "grantsSection",
    needsBotReply: false,
  },
];

export function outputPath(name, theme) {
  if (!THEMES.includes(theme)) throw new Error(`Unknown theme: ${theme}`);
  return `${OUTPUT_DIR}/${name}-${theme}.png`;
}

/** Filter `SHOTS` by a comma-separated `--only` list; unknown names are errors. */
export function selectShots(only, shots = SHOTS) {
  if (!only) return shots;
  const wanted = only.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = wanted.filter((name) => !shots.some((shot) => shot.name === name));
  if (unknown.length) {
    throw new Error(`Unknown shot(s): ${unknown.join(", ")}. Known: ${shots.map((shot) => shot.name).join(", ")}`);
  }
  return shots.filter((shot) => wanted.includes(shot.name));
}

export function selectThemes(theme) {
  if (!theme) return THEMES;
  if (!THEMES.includes(theme)) throw new Error(`--theme must be one of ${THEMES.join(", ")}`);
  return [theme];
}
