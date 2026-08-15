# Cheers landing page

A static landing/overview site for Cheers, aimed at both users and developers.
Every page shares the local `editorial.css` design system and bundled fonts. The
extension catalog adds one deterministic generation step so its package URLs and
SHA-256 values always match the bytes deployed to Pages.

Pages:

- `index.html` — English homepage (the default): product overview, feature
  tour screenshots from `imgs/`, platforms, quick start, docs links.
- `index.zh-CN.html` — Chinese mirror of the homepage; the two link to each
  other via the 中文 / EN button in the nav. Keep both in sync when editing.
- `downloads.html` / `downloads.zh-CN.html` — Download hub (macOS desktop,
  web app, ACP connector binaries, mobile build guides). Cursor-style layout;
  keep both in sync.
- `docs.html` / `docs.zh-CN.html` — Documentation hub linking to help guides,
  deploy docs, connector/MCP/plugin pages, and architecture. Keep both in sync.
- `plugins.html` / `plugins.zh-CN.html` — generated official extension catalog.
- `plugin-dev.html` — unified `.cheers-extension` and TypeScript SDK guide.
- `connector.html` / `connector.zh-CN.html` — user-facing guide to the ACP
  connector (connect your own Claude/Codex bot): install, token, config, keeping
  it updated, and the "bot can't see attached files → update the connector"
  fix. The two mirror each other via the 中文 / EN button; keep both in sync.
- `mcp.html` — Cheers MCP tool reference: the 26 tools an external agent uses,
  the request path, and post_message performance notes (English only for now).

## Preview locally

```bash
# Build the generated catalog into a disposable preview directory.
npm --prefix packages/cheers-workbench-sdk run build
cp -R website /tmp/cheers-site
node scripts/build-extension-catalog.mjs --website-dir /tmp/cheers-site
python3 -m http.server -d /tmp/cheers-site 8080
```

## Deploy

**GitHub Pages deployment is automated.** The workflow
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes
`website/` on every push to `main` that touches it (or on manual
`workflow_dispatch`). One-time setup: repo Settings → Pages → Source =
**"GitHub Actions"**. Live site: <https://haowei2000.github.io/Cheers/>

Any other static host also works after running the extension catalog generation
step. The deployed result remains plain HTML, CSS, JavaScript, images, and ZIPs.

The production Cheers frontend also publishes the App Store policy and support
URLs from this directory. `frontend/vite.config.ts` copies the English and
Chinese privacy, support, and remote-operation pages, the shared stylesheet,
font, and font license into the frontend build;
keep `website/` as the single source of truth rather than duplicating them under
`frontend/public/`. The frontend Docker build therefore uses the repository root
as its build context.

## Notes

- `editorial.css` is the authoritative visual layer for every website and
  policy page. It uses three explicit type roles: Source Serif 4 plus Source
  Han Serif CN display type for mastheads, the same families at reading sizes
  for prose, and Source Sans 3 with native multilingual fallback for controls,
  navigation, warnings, and technical labels.
- The visual language is dark editorial and borderless: neutral near-black
  paper, open card layouts, compact spacing, two-pixel control corners, no
  decorative shadows, and no pill-shaped controls. Hairline rules are reserved
  for horizontal document/section separation rather than boxed surfaces.
  Legacy inline page CSS may define page-specific layout,
  but the shared stylesheet owns the global tokens and final presentation.
- Source Serif 4, Source Han Serif CN, and Source Sans 3 are redistributed under
  the SIL Open Font License; keep their matching files in `assets/`.
- Extension sources and bilingual presentation metadata live under `extensions/`.
  Never hand-edit generated catalog or package files in a deployment artifact;
  `scripts/build-extension-catalog.mjs` owns them.
- Documentation and repo links point at `https://github.com/haowei2000/Cheers`
  — update them if the canonical repo URL changes.
- Content is intentionally kept in sync with `README.md` (and
  `README.zh-CN.md` for the Chinese page); when features or the stack change,
  update all of them.
- The feature-tour screenshots in `website/imgs/` are copies of the repo-root
  `imgs/` files used by the README — refresh both places together.
