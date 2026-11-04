---
status: draft
date: 2026-11-03
tracking: TBD
---

# Developer Traceability: Features, Bugs, E2E Cases, Plans

> **Status**: 📝 Draft / Proposal. The docs layout below is in place; the rest is not built or enforced yet. See [Rollout](#8-rollout).

This doc proposes one way to answer four everyday developer questions without having
to ask someone:

| Question | Today | Proposed answer |
|---|---|---|
| *What features exist, and where is their code?* | Read the code, `docs/arch/*`, ask | `docs/features/featuremap.yaml` → generated `docs/features/README.md` |
| *Which bugs are open for feature X? Was this fixed before?* | Search GitHub issues by keyword | Issues carry a Feature ID; fixes carry a regression test tagged with the issue |
| *Which E2E / integration cases cover feature X? What should I run?* | grep `frontend/e2e/`, `server/tests/` | Tests are tagged with Feature IDs; generated `docs/testing/E2E_CATALOG.md`; PR impact comment |
| *What is planned, and what is the status of design doc Y?* | `ROADMAP.md`, banners, obsidian notes | GitHub Project + Milestones for state; design-doc front matter for decisions |

## 1. Core principle: state in GitHub, knowledge in git, joined by IDs

```
            GitHub (state that changes daily)                git (knowledge versioned with code)
   ┌──────────────────────────────────────────┐   ┌───────────────────────────────────────────┐
   │ Issues (bugs, tasks, epics + sub-issues) │   │ docs/features/featuremap.yaml  (features) │
   │ Project "Cheers Roadmap" (status/prio)   │◄─►│ frontend/e2e/*, server/tests/* (cases)    │
   │ Milestones (= themes of work)            │   │ docs/arch/*, docs/design/*     (plans/ADR)│
   │ PRs (Fixes #n, impact comment)           │   │ commits (Conventional + trailers)         │
   └──────────────────────────────────────────┘   └───────────────────────────────────────────┘
                         ▲                                         ▲
                         └──────── stable IDs: F-…, #issue ────────┘
```

Rules that follow from it:

1. **Don't copy state into git.** No status columns in Markdown that need someone to
   edit them by hand. "Open bugs for F-x" is a GitHub query; "% done" is a Project view.
2. **Don't keep knowledge only in GitHub.** Whatever has to survive a refactor or match a
   specific commit lives in the repo: what a feature is, where its code lives, which tests
   prove it, and why it was designed that way.
3. **Generate the indexes, never hand-write them.** Catalogs are built from the source of
   truth (YAML + test tags), and CI fails if a catalog is stale. This avoids the drift
   that led to the ⚠️ SUPERSEDED banners in `docs/arch/`.
4. **One ID per feature, referenced everywhere.** `F-<area>-<slug>`, for example
   `F-chat-personal-channels`. IDs are never reused. Renaming a feature does not change its ID.

### 1.1 Docs layout

| Directory | Holds | Rule |
|---|---|---|
| `docs/help/` | User and operator manuals | Current behavior; authoritative |
| `docs/arch/` | Architecture and protocol docs | Status line at the top of each doc |
| `docs/design/` | Product and UX designs, prototypes | Status line at the top of each doc |
| `docs/developer/` | How to work on this repo | Current practice |
| `docs/ops/` | Operational references, incident analyses | Current practice |
| `docs/release/` | Release runbooks; `notes/` for release notes | One file per release |
| `docs/bugs/` | Write-ups of severe bugs | Status stays in GitHub Issues |
| `docs/archive/` | Point-in-time records | Never updated, never authoritative |
| `docs/features/`, `docs/testing/` | Generated catalogs | Added in phase 1 and 2 |

`docs/arch/` and `docs/design/` keep their paths even though they mix current and proposed
docs: 116 files outside `docs/` reference them, including code comments, so status
belongs in front matter (§5) rather than in the path.

## 2. Feature map (git: source of truth)

`docs/features/featuremap.yaml`: one entry per user-visible or operator-visible capability.
Aim for 40–80 features, not 500, at about the granularity of a help-manual section.

```yaml
# docs/features/featuremap.yaml
areas:            # same vocabulary as issue labels area:* and commit scopes
  auth:     { owner: "@haowei2000" }
  chat:     { owner: "@haowei2000" }
  bridge:   { owner: "@haowei2000" }   # Agent Bridge, dispatch, task claims
  connector: { owner: "@haowei2000" }  # packages/cheers-acp-connector-rs
  workbench: {}
  fleet:    {}
  desktop:  {}
  ios:      {}

features:
  - id: F-auth-register
    name: Email registration and sign-in
    area: auth
    status: stable            # planned | beta | stable | deprecated
    code:                     # globs, same syntax as .github/ci-paths.json
      - server/src/api/auth*.rs
      - frontend/src/features/auth/**
    docs: [docs/help/普通用户使用说明.md]
    tests:                    # optional explicit refs; tag scanning (§4) adds more
      - server/tests/auth_flows.rs
      - server/tests/password_reset_sessions.rs
    milestone: null           # GitHub milestone (theme) this belongs to, if any

  - id: F-chat-personal-channels
    name: Personal workspace Public/Private channels
    area: chat
    status: stable
    code: [frontend/src/features/chat/**, server/src/api/channels.rs, server/src/domain/channel_*.rs]
    tests: [server/tests/personal_workspace_channels.rs]

  - id: F-bridge-task-claims
    name: Proactive task claims
    area: bridge
    status: beta
    code: [server/src/domain/task_claims.rs]
    docs: [docs/design/PROACTIVE_TASK_CLAIMS.md]
    tests: [server/tests/task_claim_lifecycle.rs, server/tests/task_claim_scheduler_recovery.rs]

  - id: F-integration-github
    name: GitHub integration
    area: bridge
    status: planned
    milestone: Pluggable integrations
```

From this file, `scripts/trace.py generate` writes `docs/features/README.md`:

| Feature | Status | Area | Docs | Tests (unit / integ / e2e) | Open bugs |
|---|---|---|---|---|---|
| F-chat-personal-channels | stable | chat | – | – / 1 / 1 | [query](#) |

"Open bugs" is a **link to a GitHub search** (`is:open label:bug "F-chat-personal-channels"`),
not a count copied into git. This follows rule 1.

Why YAML in the repo instead of a GitHub Project field: the `code:` globs need to match
the code at each commit, and CI tooling (§6) has to read them offline.

## 3. Bugs (GitHub: state; git: regression evidence)

**Lifecycle**

```
Issue (bug template) ─ triage ─► labels: bug, area:<x>, sev:<1-3>; body: Feature ID
        │
        ▼
Fix PR  "fix(chat): …"  body: "Fixes #538"
        ├─ adds/updates a regression test tagged @issue-538   (required unless "no-test: <reason>")
        └─ sev:1 only → short postmortem docs/bugs/2026-11-03-connector-pin-crashloop.md
        │
        ▼
Merge → issue auto-closes → test keeps the bug from coming back, `git log --grep '#538'` finds the fix
```

**Changes to `.github/ISSUE_TEMPLATE/bug_report.yml`**

- Replace the stale `Area` dropdown (it still lists "Memory") with the `areas:` list from
  the feature map. A CI check keeps the two in sync.
- Add an optional `Feature ID` input (`F-…`), filled in at triage if the reporter doesn't know it.
- Add `Severity` (sev:1 data loss/security/outage, sev:2 broken feature, sev:3 degraded/cosmetic).
- Add `Last known good` (version/commit). It makes `git bisect` straightforward.

**Labels** (kept small; label sprawl is how this usually fails):
`bug`, `enhancement`, `area:*` (one per area), `sev:1..3`, `needs-triage`,
`regression`. Features go **in the body**, not in labels, because 60 `feat:*` labels can't be maintained.

**Postmortems** live in `docs/bugs/` only for sev:1 incidents or bugs with a non-obvious root cause:
what broke, why, the fix commit, and the guard added. See [docs/bugs/](../bugs/README.md).

## 4. E2E and integration cases (git: tests are the catalog)

The test code *is* the case definition. We only add metadata so a catalog can be generated.

**Playwright** (`frontend/e2e/*.e2e.ts`): use native tags:

```ts
test("an ordinary user registers, signs in, and creates persisted Public and Private channels in Personal",
  { tag: ["@F-auth-register", "@F-chat-personal-channels"] },
  async ({ page }) => { … });

test("failed options are visible and retryable in both settings surfaces",
  { tag: ["@F-bridge-agent-options", "@issue-N"] }, …);
```

Run a feature's cases with `pnpm exec playwright test --grep @F-chat-personal-channels`.

**Rust integration tests** (`server/tests/*.rs`): use a module doc line (no new deps):

```rust
//! Real browser registration and Home creation against the existing PG fixture.
//! cases: F-auth-register, F-chat-personal-channels
```

Per-test tags are optional: `/// cases: issue-538` on the `#[tokio::test]` fn.

**Manual cases** (iOS/macOS/App Store flows that aren't automated) go in
`docs/testing/manual/<area>.md` as numbered checklists, each with a Feature ID. At release
time, they're copied into the release issue as a checklist, so the *result* stays in GitHub (state).

**Generated catalog** `docs/testing/E2E_CATALOG.md`: for each feature, the cases that cover it
(file:line, test title, kind), the features with **no** e2e/integration coverage, and the
manual cases. The run command for each group is included.

## 5. Plans (GitHub: state; git: decisions)

| Layer | Where | Notes |
|---|---|---|
| Direction / strategy | `docs/ROADMAP.md` | Stays prose. Links to milestones, without copying their status. |
| Themes of work | **Milestones** | As used today, e.g. `Pluggable integrations` (#566–#573). A milestone replaces a separate epic issue. |
| Releases | Project field **Release** (`0.1.60`) | Milestones are already themes, and an issue can only have one, so versions go in a Project field. |
| Board / priority | **GitHub Project v2 "Cheers Roadmap"** | Fields: Status, Priority, Area, Feature (text), Release. Views: Roadmap (timeline by milestone), Bugs by area, This release. |
| Design / decision | `docs/arch/*.md`, `docs/design/*.md` | Add front matter (below). |

**Design-doc front matter** makes the existing banners machine-readable:

```yaml
---
status: draft | accepted | implemented | superseded   # superseded → superseded_by required
features: [F-bridge-task-claims]
tracking: 571            # issue number or milestone name
superseded_by: null
date: 2026-07-20
---
```

`trace.py` then generates the "Planning and Draft Documents" section of `docs/INDEX.md`
and checks two things: an `implemented` doc's features must not be `planned`, and a
`superseded` doc must name its replacement.

## 6. Git conventions and automation

**Commits / PRs** (mostly formalizing current practice):

- Conventional Commits with **scope = area**: `fix(chat): …`, `feat(bridge): …`.
- Closing keywords in the PR body: `Fixes #538`, `Part of #571`.
- PR template: replace the stale `pytest` / `gateway/migrations/` items, and add
  *"Regression test for the fixed issue (tag `@issue-N`) or reason why not"*.
  The "Features touched" section is filled in by the bot, not by hand.

**`scripts/trace.py`** (Python, same style as `scripts/ci_tool.py`, stdlib + PyYAML):

| Command | What it does | Where it runs |
|---|---|---|
| `validate` | Checks the YAML schema and unique IDs, that every `code:` glob matches ≥1 file, that every `@F-` tag and doc `features:` refers to a known ID, that issue-template areas match `areas:`, and that design-doc front matter is valid. Warns for a `stable` feature with zero integration/e2e cases. | CI `docs` lane, pre-commit |
| `generate` | Writes `docs/features/README.md`, `docs/testing/E2E_CATALOG.md`, and the planning section of `docs/INDEX.md`. CI runs `generate --check` and fails on diff. | local + CI |
| `impact <base>` | Runs `git diff --name-only <base>...HEAD`, matches the files against `code:` globs, and prints the features touched plus the e2e/integration cases to run. | PR workflow posts a sticky comment |
| `who <path>` | Reverse lookup: file → feature(s) → owner, docs, and tests. | local |

**PR impact comment** (example):

```
Features touched: F-chat-personal-channels (stable), F-auth-register (stable)
Suggested cases:  pnpm exec playwright test --grep "@F-chat-personal-channels"
                  cargo test -p server --features integration --test personal_workspace_channels
Docs to review:   docs/help/普通用户使用说明.md
Open bugs:        2 open in F-chat-personal-channels → <search link>
```

**Optional, later:** a weekly Action builds a "feature health" table (open bugs by severity,
coverage, last commit date) and feeds it into `architecture-status.page.json`, so the
existing status page reports live numbers instead of a hand-written snapshot.

## 7. Workflows: how a developer uses it

- **Onboarding to an area:** open `docs/features/README.md`, filter by area, then read the
  feature's docs, open its code globs, and run its cases.
- **"Where does this file belong?"**: `python scripts/trace.py who server/src/domain/task_claims.rs`.
- **Picking up a bug:** the issue carries an F-ID, which leads to the code, existing cases,
  and similar closed bugs (`is:closed "F-x"`). Write a failing test tagged `@issue-N`, fix it,
  then open a PR with `Fixes #N`.
- **"Was this fixed before?"**: `git log --grep '#538'`, `grep -r '@issue-538'`, or search closed issues by F-ID.
- **Planning work:** create or reuse a milestone, add its issues to the Project, add the
  F-ID as `planned` in the feature map, and write the design doc with front matter `status: draft`.
- **Cutting a release:** read the Project's "This release" view for done/open, copy the manual cases
  into the release issue, and draft release notes from its closed issues grouped by area.

## 8. Rollout

Each phase is usable on its own, and nothing blocks merges until phase 3.

0. **Docs cleanup (done).** Layout in §1.1, broken links fixed, stale templates corrected.
1. **Foundations (1 PR).** Seed `featuremap.yaml` with ~40 features from `frontend/src/features/*`,
   `server/tests/*`, and the help manual. Add `trace.py validate|generate|who`. Fix the stale issue
   and PR templates. Create `area:*` / `sev:*` labels and the Project. *(Labels and the Project are
   GitHub-side changes; they need the maintainer's approval.)*
2. **Tag tests.** Add F-tags to the 4 Playwright tests and ~36 `server/tests/*.rs`, and generate the
   E2E catalog. Add front matter to the active design docs, and leave historical ones as `superseded`.
3. **Enforce.** Make `generate --check` and `validate` required in CI, and add the PR impact comment.
   Requiring regression tests for `Fixes #` PRs stays a template checkbox at first.
4. **Optional.** Feed feature health into the architecture status page, and generate release
   notes from the Project's Release field.

## 9. Open decisions

- **Granularity.** One F-ID per help-manual section (recommended), or per screen/endpoint.
- **Feature field.** Feature ID in the issue body, parsed by tools (recommended for scale), or as `feat:*` labels.
- **zh-CN.** The generated catalogs are English-only, with feature `name` optionally bilingual (`name_zh`).
- **Ownership.** Whether `areas.owner` should also generate `.github/CODEOWNERS`.
