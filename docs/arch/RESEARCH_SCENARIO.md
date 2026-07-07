# Research Scenario ("research-lab") — Design Proposal

> **Status**: Proposal (v1) · **Date**: 2026-07-07 · **Language**: English default
>
> Goal: show that Cheers can host an **AutoSci-style scientific-research workflow**
> ([github.com/skyllwt/AutoSci](https://github.com/skyllwt/AutoSci)) as a *scenario
> example* — **without adding backend orchestration or compute** — by composing
> primitives that already ship: the per-channel filesystem (`context_files` / `fs.*`),
> the declarative Environment/lens workbench, the MCP tool bridge (incl. artifact
> return via `inbox_deliver`/`inbox_stage`), and human↔bot channel membership.
>
> This is design intent. Verify against code before implementing. Anchor files:
> `frontend/src/features/chat/workbench/` (manifest + lenses),
> `server/src/resource/fs.rs` (filesystem), `server/src/gateway/dispatcher.rs`
> (`load_pinned_context`), `packages/cheers-mcp-server/src/main.rs` (agent tools).
> Related: [context-and-environment.md](./context-and-environment.md),
> [WORKBENCH.md](./WORKBENCH.md).

> **Decisions taken 2026-07-07 (discussion):**
> 1. **Compute lives in the agent's own environment** — Cheers stays a lab *notebook*,
>    not a compute cluster. No sandbox / job-runner is added. (§4.1, §7)
> 2. **A `metrics` chart lens is a committed MVP-1 deliverable** — experiment results
>    render as curves, not just a table. Frontend-only, one new built-in lens. (§6.2)
> 3. **The demo agent is Codex (`codex-acp`), not Claude.** Verified end-to-end in code
>    (§4.2): Codex is a first-class agent preset, MCP tool injection and pinned-convention
>    delivery are agent-agnostic. Consequence: AutoSci's Claude-Code skill pack cannot be
>    loaded into Codex — the **pinned convention file is the portable rules channel**, which
>    is exactly what this design already relies on.
>
> **Implementation status (2026-07-07):** MVP-0 and MVP-1 are implemented — the
> `research-lab` template ships at `frontend/src/features/chat/workbench/examples/research-lab.json`
> (mirror: `docs/arch/examples/research-lab.template.json`), the `chart` lens is a
> built-in (`builtin:chart`), and manifest `pin` auto-pinning works on activation.
> Run-book: §10. MVP-2 (live Codex agent) is next.

---

## 0. TL;DR / verdict

**Feasible, and the architectural fit is unusually good.** AutoSci *is* a Claude-Code
agent plus a wiki-shaped memory and ~30 lifecycle slash-commands. Cheers is
*external-agent-first*: the platform ships **no** runtime and expects exactly that kind
of external agent to connect and operate a channel's shared files. So this is not
"port a foreign system in" — it is "connect AutoSci's agent to a Cheers channel, let
its memory live in `context_files`, and let humans join the loop through chat."

The concrete deliverable is **one JSON template + one convention file + one new chart
lens + a short run-book**. Only the chart lens touches code (frontend). No Rust, no DB.

**Deliberate non-goal:** do **not** rebuild AutoSci's discovery→…→writing *pipeline*
or its *experiment execution* inside Cheers. The platform is *pull, not push* (§7);
both the phase orchestration **and the compute** live in the **agent** (exactly as in
AutoSci itself), not in the platform.

---

## 1. What AutoSci is, and what we borrow

AutoSci automates the research lifecycle: **knowledge base** (wiki ingest of papers +
cross-refs) → **ideation & experimentation** (idea generation, code generation, run,
monitor, ablation) → **writing & dissemination** (draft, figures, rebuttal). It is
built on Claude Code, keeps a **graph-structured persistent memory**, and inserts
**human gates** at decision points.

| AutoSci concept | Borrow? | How it lands in Cheers |
|---|---|---|
| Wiki / persistent memory | ✅ | Per-channel `context_files` tree (§3), rendered by lenses |
| Lifecycle slash-commands | ✅ (as conventions) | The agent's *own* capability — the platform doesn't re-implement it. **Note:** AutoSci's skill pack is Claude-Code-specific and does not load into Codex; the lifecycle know-how is ported into the pinned convention file (+ optionally Codex-side instructions) |
| Human decision gates | ✅ | The channel chat: human + bot are both first-class members; `post_message` + `@mention` |
| Paper ingest (arXiv / Semantic Scholar) | ✅ | The agent's *own* web/MCP tools; results written via `desk_write` |
| **Experiment execution** (gen code, run, monitor) | ✅ **compute = agent's** | The agent runs it in **its own** environment; Cheers never runs code (§4.1) |
| **Experiment results** (metrics, curves, ablation) | ✅ | Metrics → `desk_write` files (table + **chart** lens); plots/logs → `inbox_deliver`/`inbox_stage` attachments (rendered by PdfViewer/image preview) |
| Knowledge-graph viz | ➖ later | A sandboxed workbench plugin (§6.3), or a table/markdown lens for MVP |
| Daily recommendation email | ❌ MVP | No built-in scheduler (SMTP exists); out of MVP scope (§6.4) |
| Cross-model independent review | ✅ | A second bot in the same channel (mesh) reviewing the shared draft/results |

---

## 2. Mapping: AutoSci needs → Cheers primitives (all already built)

| Need | Cheers primitive (verified in code) |
|---|---|
| Shared, versioned research memory | `context_files` table + `fs.ls/read/write/edit/append/rm/mv` — `server/src/resource/fs.rs` (materialized-path tree, optimistic lock `if_version`, 256 KB/file, 1024 files/channel) |
| Agent reads/writes that memory | MCP bridge `desk_*` tools — `packages/cheers-mcp-server/src/main.rs` (`desk_read`→`fs.read`, `desk_write`→`fs.write`, `desk_edit`, `desk_append`, `desk_rm`, `desk_mv`, `desk_list`→`fs.ls`) |
| Agent posts / reads discussion | `post_message`→`channel.messages.create`, `read_messages`, `search_messages`, `read_activity` |
| **Agent returns result artifacts** (plots, logs, checkpoints) | `inbox_deliver` (new attachment, base64 ≤8 MB) and `inbox_stage` (large file stays on the agent's machine, gateway fetches lazily on click) — `main.rs` |
| Agent reads uploaded inputs (datasets, PDFs) | `inbox_list`/`inbox_open` (read chat uploads by `file_id`; `as_base64` for binaries) |
| Humans view result artifacts | `frontend/src/features/chat/{FilePreviewModal,PdfViewer,DiffView}.tsx` — PDF/image plots, code diffs |
| Humans see the memory as structured boards | Declarative **lens** rendering — `workbench/lens/builtins.tsx`: **table**, **kanban**, **markdown** (read/write one `context_files` file with optimistic lock). **New: `chart`** (§6.2) |
| Scenario packaged as a reusable template | Declarative **manifest** — `workbench/manifest.ts` (`{id,title,views:[{id,title,file,lens,config}],seed}`), create-only `seedManifest` |
| Scenario "rules" reach the agent | Files listed in `.workbench.json.pinned` → their **bodies** injected into every bot prompt — `server/src/gateway/dispatcher.rs::load_pinned_context` |
| Two bots collaborating (author + reviewer) | Decentralized mesh: bots are members, bot@bot mentions supported (see [DECENTRALIZED_MESH.md](./DECENTRALIZED_MESH.md)) |

Two shipped example templates already cover ~80% of the *organizational* half:
`workbench/examples/research.json` and `lit-review.json`. This proposal generalizes them
into one lab scenario, **adds the experiment-execution/results loop** (§4.1), and
defines the one new lens + the one small gap (auto-pin) that remain.

---

## 3. The scenario design: `research-lab`

A single Environment template that seeds the memory tree, binds each file to a lens,
and ships a behavioral convention for the agent.

### 3.1 The memory tree (seeded files)

```
research/papers.json        table    — literature table (ingest target)
experiments/runs.json       table    — run ledger: id · config · status · key metric · artifact
experiments/metrics.json    chart    — metric curves (loss/acc vs step) — NEW lens (§6.2)
experiments/board.json      kanban   — Backlog / Running / Analyzed / Done (human-gated flow)
research/findings.json      table    — claim → evidence → confidence → source
research/ideas.md           markdown — running idea log (human + bot)
draft/paper.md              markdown — the manuscript draft
prompts/lab-conventions.md  markdown — the agent's scenario rules (→ pinned)
```

Per-run detail (spec, code, raw log) lives under `experiments/exp-XXX/` as desk files
(`spec.md`, `train.py`, `log.txt`) — read via `desk_read`, code diffs via `DiffView`.

Data shapes must match each lens (verified in `builtins.tsx`; chart per §6.2):
- **table** file = *array of row objects*; columns declared in the view `config`.
- **kanban** file = `{ "columns": [ { "name": string, "items": string[] } ] }`.
- **markdown** file = a plain *string*.
- **chart** file = `{ "xLabel", "yLabel", "series": [ { "name", "points": [[x,y], …] } ] }`.

### 3.2 The manifest (`research-lab.json`)

Ships at `workbench/examples/research-lab.json` (mirror:
`docs/arch/examples/research-lab.template.json`). Validated by `validateManifest`;
unknown lenses are rejected — `chart` is a registered built-in (§6.2), so the
`metrics` view validates and the template ships with it.

```json
{
  "id": "research-lab",
  "title": "Research Lab",
  "pin": ["prompts/lab-conventions.md"],
  "views": [
    {
      "id": "papers", "title": "Literature", "file": "research/papers.json", "lens": "table",
      "config": { "columns": [
        { "key": "title", "label": "Title" },
        { "key": "authors", "label": "Authors" },
        { "key": "venue", "label": "Venue" },
        { "key": "year", "label": "Year" },
        { "key": "status", "label": "Status", "options": ["To read", "Reading", "Read", "Cited"] },
        { "key": "relevance", "label": "Relevance" }
      ] }
    },
    {
      "id": "runs", "title": "Runs", "file": "experiments/runs.json", "lens": "table",
      "config": { "columns": [
        { "key": "id", "label": "Run" },
        { "key": "config", "label": "Config" },
        { "key": "status", "label": "Status", "options": ["Queued", "Running", "Done", "Failed"] },
        { "key": "metric", "label": "Key metric" },
        { "key": "artifact", "label": "Artifact" }
      ] }
    },
    { "id": "metrics", "title": "Metrics", "file": "experiments/metrics.json", "lens": "chart" },
    { "id": "board", "title": "Board", "file": "experiments/board.json", "lens": "kanban" },
    {
      "id": "findings", "title": "Findings", "file": "research/findings.json", "lens": "table",
      "config": { "columns": [
        { "key": "claim", "label": "Claim" },
        { "key": "evidence", "label": "Evidence" },
        { "key": "confidence", "label": "Confidence", "options": ["Low", "Medium", "High"] },
        { "key": "source", "label": "Source" }
      ] }
    },
    { "id": "ideas", "title": "Ideas", "file": "research/ideas.md", "lens": "markdown" },
    { "id": "draft", "title": "Draft", "file": "draft/paper.md", "lens": "markdown" }
  ],
  "seed": {
    "research/papers.json": [
      { "title": "Attention Is All You Need", "authors": "Vaswani et al.", "venue": "NeurIPS", "year": "2017", "status": "Read", "relevance": "Transformer baseline" }
    ],
    "experiments/runs.json": [],
    "experiments/metrics.json": { "xLabel": "step", "yLabel": "value", "series": [] },
    "experiments/board.json": { "columns": [
      { "name": "Backlog", "items": ["Reproduce baseline"] },
      { "name": "Running", "items": [] },
      { "name": "Analyzed", "items": [] },
      { "name": "Done", "items": [] }
    ] },
    "research/findings.json": [],
    "research/ideas.md": "# Ideas\n\nOne idea per section: hypothesis, why it might work, how to test it.\n",
    "draft/paper.md": "# (working title)\n\n## Abstract\n\n## 1. Introduction\n\n## 2. Method\n\n## 3. Experiments\n\n## 4. Related work\n\n## 5. Conclusion\n",
    "prompts/lab-conventions.md": "You are a research collaborator in this channel. The channel's shared memory is a file tree you read/edit with the desk_* tools. YOU run experiments in your OWN environment; the platform does not run code. Sync results back as files/attachments.\n\nConventions:\n- `research/papers.json` (table): append a row per paper. Never invent citations; if unsure, mark relevance \"unverified\".\n- Experiments: write the spec+code under `experiments/exp-XXX/`, add a row to `experiments/runs.json` and a card to `experiments/board.json` BEFORE running. Move the card to \"Running\", then \"Analyzed\"/\"Done\".\n- After a run: update the run's row (status + key metric + artifact name), append the metric curve to `experiments/metrics.json` (one series per metric, points as [step, value]), and deliver plots/logs as attachments with inbox_deliver (or inbox_stage for large files).\n- `research/findings.json`: record claim -> evidence -> confidence -> source. Use \"High\" only for results you can point to a concrete artifact for.\n- `draft/paper.md`: edit sections in place; never rewrite the whole file at once.\n- HUMAN-GATED steps (propose in chat, wait for a human): choosing the research question, launching an experiment, and submitting the draft.\n"
  }
}
```

> `pin` is implemented (§6.1): activation merges it into `.workbench.json.pinned`
> (deduped), so the convention file reaches the agent with no manual step.

### 3.3 After activation: `.workbench.json`

The workbench is **file-centric** (no tabs — 2026-07-07): the drawer body is one file
browser, and a selected file has exactly three controls — **Pin**, **Preview** (bound
or best content-matching renderer; switcher when several match), **Raw** (textarea
fallback). Activation (`activate` in `WorkbenchDrawer.tsx`) seeds the files and
collapses each manifest view into a **binding** (+ optional lens **config**):

```json
{
  "_doc": "Workbench config …",
  "environment": "research-lab",
  "pinned": ["prompts/lab-conventions.md"],
  "bindings": {
    "research/papers.json": "builtin:table",
    "experiments/runs.json": "builtin:table",
    "experiments/metrics.json": "builtin:chart",
    "experiments/board.json": "builtin:kanban",
    "research/findings.json": "builtin:table",
    "research/ideas.md": "builtin:markdown",
    "draft/paper.md": "builtin:markdown"
  },
  "configs": {
    "research/papers.json": { "columns": [ … ] },
    "experiments/runs.json": { "columns": [ … ] },
    "research/findings.json": { "columns": [ … ] }
  }
}
```

Bindings and configs are merged **create-only** (a user's explicit choice is never
overwritten); `pin` is deduped in.

`pinned` is what makes the convention real: `load_pinned_context` reads each pinned
path's body and injects `"[Pinned: prompts/lab-conventions.md]\n<body>"` into **every**
bot request. That is the *semantic layer* — soft, prompt-delivered. It is **not** an
enforcement boundary; the real gate is channel role on every `fs.*` write
(`server/src/resource/mod.rs`).

---

## 4. The minimal closed loop (what the demo shows)

```
1. Owner creates a channel, opens the Workbench drawer, picks "Research Lab".
   → seeds the tree, pins the convention, binds each file to its lens (papers/runs →
   table, metrics → chart, board → kanban); selecting a file previews it.
2. A Codex agent (codex-acp via the ACP connector) is a member of the channel.
   → every prompt it receives now carries the pinned convention body.
3. Human: "@bot survey retrieval-augmented generation, 2023–2024."
   → agent uses its OWN search tools, then desk_write appends rows to research/papers.json.
   → the human watches the Literature table fill in live.
4. Human: "run the baseline vs. +reranker on our dataset."            ← human gate
   → §4.1 experiment loop.
5. Human reviews metrics/plots, replies "ablate the reranker depth."  ← human gate
   → loop back to 4.
6. Human: "draft the results section."                                ← human gate
   → agent desk_edit's draft/paper.md §3 from runs.json + findings.json.
```

Everything the human sees and everything the bot writes is the **same**
`context_files` state + attachments — one shared workspace, rendered two ways
(chat + lens).

### 4.1 Experiment execution & results — the compute boundary

**Cheers is the lab notebook, not the compute cluster.** The agent runs experiments in
**its own** environment (the ACP agent — Codex here — executes code on the connector
host within its own sandbox/approval policy, or drives its own remote compute). Cheers
never executes code; it only stores and renders what the agent writes back. This is the
same reason AutoSci can "run experiments": it *is* an execution-capable agent — connect
such an agent here and the capability comes with it, now made **visible and
human-gated** for a team.

The result flow (all via existing tools):

```
spec + code   → desk_write  experiments/exp-001/{spec.md,train.py}   (DiffView renders code)
run           → executes in the AGENT's env                          (Cheers not involved)
progress      → post_message deltas to chat + desk_edit runs.json / move board card   ("monitoring")
metrics       → desk_write  experiments/metrics.json  (chart lens)  + runs.json row (table)
plots / logs  → inbox_deliver (≤8MB)  or  inbox_stage (large, lazy)  (PdfViewer / image preview)
a conclusion  → append to research/findings.json                     (human-gated for "High")
```

Notes / boundaries this creates:
- **Long-running / async runs.** A multi-hour run outlives one agent turn. The agent
  fires it in the background in its own env and reports progress as it goes (chat deltas
  + `runs.json` status). Cheers has no job monitor — "is it still running" is whatever
  the agent last wrote. (Open question §9.4.)
- **Reproducibility is the agent's, not the platform's.** `runs.json` records the config
  and points at the artifact; the actual environment/seed/hardware live with the agent.
  The notebook captures *what was claimed*, gated by humans who can ask for the artifact.
- **No result is trusted because a bot said so.** The human gate + the requirement that
  "High" confidence findings point at a concrete delivered artifact is the check.

### 4.2 Agent choice: Codex (verified in code, 2026-07-07)

The demo agent is **Codex** via `codex-acp`. Verified facts (static trace, develop @
`66ce732a`):

- **First-class support.** Ready-made connector config:
  `packages/cheers-acp-connector-rs/examples/cheers-daemon.codex.toml` (generic stdio
  adapter, binary `codex-acp`); docs-canonical "Minimal Codex example" in
  [CONNECTOR_TOML_CONFIG.md](./CONNECTOR_TOML_CONFIG.md). The gateway ships a codex
  `AgentPreset` (`server/src/domain/connector_config.rs`) and enrollment accepts
  `agent_type=codex` (`server/src/api/enrollment.rs`).
- **Tools are agent-agnostic.** `inject_cheers=true` hands Codex the same
  `desk_*`/`inbox_*`/`post_message` MCP tools; there is zero agent-type branching in
  `cheers-mcp-server`.
- **Pinned conventions are agent-agnostic (the load-bearing fact).** `dispatcher.rs`
  puts pinned bodies in the task frame's top-level `pinned: string[]`; the connector
  prepends them to the `session/prompt` text block for **every** agent — regression
  test at `cheers-acp-connector-rs/src/bridge_runtime/mod.rs` ("pinned convention block
  must be injected every prompt"). So the scenario's rules reach Codex exactly as they
  would reach Claude.
- **Governance differences to set up deliberately.** Codex's preset has no
  `permission_mode` and an empty `allowed_modes` (any mode string passes the gateway
  check); a `danger-full-access` Codex self-approves and never emits
  `session/request_permission` (no approval cards). For this scenario: keep connector
  `policy.permission.auto_allow = false` (approvals forwarded to the channel approval
  card) and govern execution with Codex's `approval_policy` / `sandbox` config options
  (both whitelisted in its preset).
- **Pinned size is a hard limit.** Pinned bodies count toward the connector's
  `max_prompt_bytes`; an oversize prompt is rejected **wholesale** (not truncated).
  `prompts/lab-conventions.md` must stay small.

---

## 5. Delivery mechanics (grounded in code)

- **Seeding is create-only.** `seedManifest` writes each seed path with `if_version=0`;
  a `VERSION_CONFLICT` is swallowed (file exists → keep the user's data). Re-activating
  never clobbers work. (`manifest.ts`)
- **Convention → prompt.** Only files listed in `.workbench.json.pinned` are injected,
  only their *bodies*. Keep the convention small; it is paid on every turn.
  (`dispatcher.rs::load_pinned_context`)
- **Reads vs writes.** The agent *pulls* bodies on demand (`desk_read`); writes are
  always tools, always channel-role gated. Artifacts return via `inbox_*`, not by
  writing into the desk tree (desk is the agent's private working set; inbox is the
  shared chat plane).
- **Human and bot share one filesystem.** Browser `resource_req` and MCP `desk_*` hit
  the same `fs.rs`; destructive `fs.rm`/`fs.mv` on the human path require owner/admin.

---

## 6. Gaps & required work (honest inventory)

| # | Item | Effort | Touches backend? | Status |
|---|---|---|---|---|
| 6.1 | Manifest auto-pin (deliver convention on activation) | ~5–10 lines FE | No | ✅ **implemented 2026-07-07** |
| 6.2 | **`chart` (metrics) lens** | one built-in lens, FE | No | ✅ **implemented 2026-07-07** |
| 6.3 | Knowledge-graph visualization | sandbox plugin | No (existing host) | Phase 2 |
| 6.4 | Daily-recommendation scheduler | new subsystem | Yes | out of scope |
| 6.5 | Long-running / async run status | design only (open Q) | No (MVP) | §9.4 |

### 6.1 Auto-pin — ✅ implemented
`TemplateManifest` now carries optional `pin?: string[]` (validated in
`validateManifest`); activation goes through a shared `activate(manifest)` in
`WorkbenchDrawer.tsx` that seeds files, writes renderer bindings + lens configs
(create-only), and merges `manifest.pin` into `cfg.pinned` (deduped). Templates are
self-arming: pick "Research Lab" → the agent is already told the rules.

### 6.2 The `metrics` chart lens — ✅ implemented
Built-in lens `chart` in `workbench/lens/builtins.tsx`, registered as `builtin:chart`
in `renderers/registry.ts` (pickable; offered only for JSON files carrying a `series`
key). View-only (machine-written data). File shape:
`{ "xLabel", "yLabel", "series": [ { "name", "points": [[x,y], …] } ] }` — one line per
series. Self-contained SVG, no external libs (matches the sandbox/CSP posture). Built
per the `dataviz` method: fixed-order 8-slot series palette **validated** against the
zinc-950 surface (all checks pass — contrast ≥3:1, worst adjacent CVD ΔE 23.6), legend
for ≥2 series + direct end-labels for ≤4 (identity never color-alone), hover
crosshair + tooltip, recessive hairline grid, tabular numerals.

### 6.3 Knowledge graph — sandbox plugin (Phase 2)
Paper/citation graph fits the sandboxed iframe plugin renderer
(`workbench/sandbox/`, table `workbench_plugins`, example
`sandbox/examples/research-plugin.html`): reads a `context_files` JSON via the
whitelisted postMessage fs proxy, draws client-side, network-isolated by CSP.

### 6.4 Daily recommendation / email — out of scope
SMTP exists, but no scheduler/cron. A recurring digest needs new backend work; excluded
from the MVP. If wanted later, trigger the agent from an external cron hitting a channel
— keep orchestration out of the gateway.

---

## 7. Non-goals / anti-patterns (read before coding)

- **Cheers is NOT the compute cluster.** No sandbox, no job-runner, no code execution.
  Experiments run in the agent's environment; the platform stores and renders results.
- **Do NOT build a pipeline/DAG runner in the Rust gateway.** Cheers is single-writer,
  pull-based, deliberately has no orchestration layer. AutoSci's phase sequencing lives
  in the *agent's* skills — the correct home for it.
- **Do NOT add a `memory`/`wiki` substrate.** Files are the only substrate; the "wiki"
  is `context_files` rendered by lenses.
- **Do NOT push file bodies into the agent by default.** Only small pinned conventions
  are pushed; everything else is pulled.
- **Do NOT rely on the convention prompt for authorization.** It is advisory; writes are
  gated by channel role in `fs.rs` regardless.

---

## 8. Rollout

1. ✅ **MVP-0 (template + docs):** `research-lab.json` in `workbench/examples/` + mirror
   `docs/arch/examples/research-lab.template.json`; run-book in §10. Demoable via "Temp
   template" in the Workbench drawer.
2. ✅ **MVP-1 (the two FE items):** (a) §6.2 `chart` lens (the template ships **with**
   the `metrics` view); (b) §6.1 auto-pin — activation arms the convention. Frontend-only.
3. **MVP-2 (live agent, the §4.1 loop):** connect a **Codex** bot via
   `packages/cheers-acp-connector-rs` using `examples/cheers-daemon.codex.toml` (§4.2);
   run ingest → experiment → metrics/plots → draft end-to-end.
4. **Phase 2 (optional):** knowledge-graph sandbox plugin (§6.3); a reviewer bot for
   cross-model review of results; timeline view.

---

## 9. Open questions

1. **Install as a *global* template?** Global templates are admin-installed
   (`workbench_templates`, `server/src/api/workbench.rs`), shared by every channel;
   session/temp templates are ephemeral. For a shipped example, global is the right home.
2. **How much AutoSci know-how to port into the convention?** AutoSci's skill pack is
   Claude-Code-only and cannot be loaded into Codex (§4.2). The lifecycle know-how must
   be carried by `prompts/lab-conventions.md` (small — see the pinned-size limit) and/or
   Codex-side instructions (e.g. AGENTS.md in the connector workspace). Decide the split.
3. **One bot or two?** Cross-model result review needs a second bot; decide MVP vs Phase 2.
4. **Long-running run status (§4.1).** For multi-hour runs, is "last thing the agent
   wrote to `runs.json`" enough, or do we later want a lightweight liveness signal
   (agent heartbeat → status)? MVP: agent-reported only; revisit if it hurts.

---

## 10. Run-book (MVP demo)

1. **Start the stack** (kind + Helm, see `CLAUDE.md`): UI at <http://localhost:30080>
   (`admin` / `admin12345`).
2. **Create a channel**, open the **Workbench** drawer (channel header).
3. **Load the scenario**: click **Temp template** and pick
   `frontend/src/features/chat/workbench/examples/research-lab.json` (or drag the file
   onto the drawer). This seeds the file tree, binds each file to its lens (select
   `research/papers.json` in the browser → it previews as a table; `experiments/metrics.json`
   → chart), and **auto-pins** `prompts/lab-conventions.md` (📌 appears in the drawer
   header). Every file offers Pin / Preview / Raw. To share the scenario with all
   channels instead, an admin installs it as a global template in Settings → Workbench
   extensions.
4. **Connect the Codex bot** (MVP-2): create a bot (Bots → onboarding wizard,
   agent type **codex**), export its token, then on the agent host:
   `cce-acp-connector start --config cheers-daemon.codex.toml` (start from
   `packages/cheers-acp-connector-rs/examples/cheers-daemon.codex.toml`; requires
   `codex-acp` on PATH — its absence is the #1 "bot never comes online" cause). Invite
   the bot into the channel.
5. **Run the loop** (§4): ask the bot to survey a topic → watch `Literature` fill;
   approve an experiment in chat → watch `Runs`/`Board`/`Metrics` update and plots
   arrive as attachments; ask for a draft section → `Draft` tab.
6. **Verify the pin reached the agent**: the bot's first reply should follow the
   conventions (e.g. it appends to `research/papers.json` rather than pasting a paper
   list into chat). Server-side, `load_pinned_context` injects
   `[Pinned: prompts/lab-conventions.md]` into every task frame.
