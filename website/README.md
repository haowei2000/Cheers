# Cheers landing page

A self-contained landing/overview site for Cheers, aimed at both users and
developers. No build step and no external dependencies — each page inlines all
CSS and JS, so it works offline and on any static host.

Pages:

- `index.html` — English homepage (the default): features, feature-tour
  screenshots from `imgs/`, the `#clients` section (Web / macOS / iOS /
  Android), quick start, docs links.
- `index.zh-CN.html` — Chinese mirror of the homepage; the two link to each
  other via the 中文 / EN button in the nav. Keep both in sync when editing.
- `plugin-dev.html` — workbench renderer plugin guide (English only for now).
- `connector.html` / `connector.zh-CN.html` — user-facing guide to the ACP
  connector (connect your own Claude/Codex bot): install, token, config, keeping
  it updated, and the "bot can't see attached files → update the connector"
  fix. The two mirror each other via the 中文 / EN button; keep both in sync.
- `mcp.html` — Cheers MCP tool reference: the 26 tools an external agent uses,
  the request path, and post_message performance notes (English only for now).

## Preview locally

```bash
# just open it
open website/index.html          # macOS

# or serve it (nicer for testing relative behavior)
python3 -m http.server -d website 8080   # → http://localhost:8080
```

## Deploy

**GitHub Pages deployment is automated.** The workflow
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes
`website/` on every push to `main` that touches it (or on manual
`workflow_dispatch`). One-time setup: repo Settings → Pages → Source =
**"GitHub Actions"**. Live site: <https://eleperson.github.io/Cheers/>

Any other static host also works — the site is a handful of self-contained
HTML files plus the `imgs/` screenshots, with no build step.

The production Cheers frontend also publishes the App Store policy and support
URLs from this directory. `frontend/vite.config.ts` copies the English and
Chinese privacy, support, and remote-operation pages into the frontend build;
keep `website/` as the single source of truth rather than duplicating them under
`frontend/public/`. The frontend Docker build therefore uses the repository root
as its build context.

## Notes

- Light/dark theme follows the OS by default; the ◐ button cycles
  auto → light → dark and remembers the choice.
- Documentation and repo links point at `https://github.com/ElePerson/Cheers`
  — update them if the canonical repo URL changes.
- Content is intentionally kept in sync with `README.md` (and
  `README.zh-CN.md` for the Chinese page); when features or the stack change,
  update all of them.
- The feature-tour screenshots in `website/imgs/` are copies of the repo-root
  `imgs/` files used by the README — refresh both places together.
