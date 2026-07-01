# Session workdir & root set (per-session `cwd` + `additionalDirectories`)

> Status: **All phases (0–6) implemented** on `feat/session-workdir-rootset`. Backend +
> connector are compile- and unit-test verified; UI + full round-trip need the kind stack
> to verify (see per-phase notes). Phase 6 confines realize to the **session root set** (the
> chosen behavior) — a behavior change on a previously-unconfined path; verify before release.

## Phase 5–6 as built

- **Phase 5 (browse scoping):** `workspace_req` gained a `roots` field; the connector's
  `effective_roots(session_roots, fallback_all=true)` narrows browsing to
  `session_roots ∩ allowed_roots` when a session is given, else the full `allowed_roots`.
  The browse REST endpoints take an optional `session_id`, resolve that session's
  `[cwd, ...additional_dirs]`, and pass it; `RemoteWorkspaceDialog` accepts a `sessionId`
  prop. `allowed_roots` stays the hard clamp.
- **Phase 6 (realize confinement):** `handle_realize_file` now canonicalizes the local path
  and requires it within `effective_roots(session_roots, fallback_all=false)` — the session
  root set, or `[default_cwd]` when unpinned. The gateway passes the **(bot, channel) primary
  session's** root set. NOTE: a file produced by an "other" session with a narrower/different
  root set is confined against the *primary's* set (no session linkage on `file_records`);
  revisit if realize needs per-session precision. The channel-attachment pull (`inbox_open`)
  is a different axis and is untouched.
> Related: [SESSION_MODEL.md](SESSION_MODEL.md), [BOT_CONFIG_GOVERNANCE.md](BOT_CONFIG_GOVERNANCE.md),
> [ACP_FS_PROXY.md](ACP_FS_PROXY.md), [AGENT_BRIDGE_PROTOCOL.md](AGENT_BRIDGE_PROTOCOL.md).
> ACP spec: <https://agentclientprotocol.com/protocol/v1/session-setup#working-directory>.

## Why

Today a bot's working directory is a single **connector-wide** static value
(`policy.workspace.default_cwd`); every session, every channel shares it, and the only
way to change it is a connector config update that **restarts the agent process**. We
want each session to choose *where it works* — set once when the session is created
(inviting a bot = creating its primary session; "new session" = an extra one), validated
on the spot, and reflected consistently into the human file browser.

The ACP protocol already models exactly this, so we adopt its shape rather than invent one.

## What ACP mandates (guardrails — never violate)

From `session/new` (and `session/load` / `session/resume`):

1. `cwd` is **required**, **MUST be absolute**, and is **immutable for the session's lifetime**.
   `session/new` and `session/load` for the same session **MUST** carry the **same** `cwd`.
2. `cwd` **MUST** be used regardless of where the agent subprocess was spawned — so a
   per-session `cwd` needs **only** a different `session/new` argument, **no process restart**.
3. The session's **effective root set** is `[cwd, ...additionalDirectories]`; it **SHOULD**
   bound the agent's filesystem tool operations. Each `additionalDirectories` entry **MUST**
   be absolute.
4. On `session/load`/`resume` the client **MUST resend the full** `additionalDirectories`
   list (no implicit restoration; empty/omitted ⇒ root set collapses to `[cwd]`). That list
   **may differ** across loads **as long as `cwd` matches**.

Corollary levers:

| Want | Lever | Cost |
|---|---|---|
| Change the **primary working dir** | new `cwd` ⇒ **new session** | a session |
| Add/remove **accessible dirs** | change `additionalDirectories`, same session, next load | none |

## The model: one nested root set

```
session root set  =  cwd (immutable)  +  additional_dirs (mutable across loads)
                        └──────────────── ⊆ ────────────────┘
                                  allowed_roots
                     (connector L0, host/owner-configured, the ONLY hard clamp)
```

- **`allowed_roots`** stays the outer, hard-enforced boundary (`canonicalize +
  starts_with`, gated by `backend_may_set_cwd`). It is **not** replaced.
- **session root set** is an inner, per-session scope `⊆ allowed_roots`, and becomes the
  single source of truth for **both** consumers:
  - the **agent** (ACP `session/new`/`load` root set), and
  - the **human file browser** (workspace browse scoped to the session's roots).
- To the agent the root set is **advisory (SHOULD)**; the connector's `allowed_roots` clamp
  on every `workspace_req` / local-path resolution is the real enforcement.

## Storage

`cheers_sessions.metadata` (jsonb, exists) gains one key — same for primary and "other":

```jsonc
"workspace": { "cwd": "/abs/dir", "additional_dirs": ["/abs/other", ...] }
```

`provider_session_id` is already nullable → the DB natively models "platform session
created, ACP session not yet established" (invite creates the row; ACP `session/new` fires
lazily on first prompt using the stored `cwd`).

## Governance (who may set what)

- **Invite a bot into a channel** = a `session_create` for that bot ⇒ gated by an **AND**:
  1. caller may modify this channel's membership (`ensure_channel_admin`, channel side), **and**
  2. caller has `cheers/session_create` INITIATE for this bot (bot side; owner-default,
     grantable — see [BOT_CONFIG_GOVERNANCE.md](BOT_CONFIG_GOVERNANCE.md)).
  This closes the pre-existing gap where any channel admin could bind *any* bot with no
  bot-side authorization.
- **`cwd` authority is anchored to the bot owner**, not the inviter: the *default* primary
  `cwd` is owner-controlled; a non-owner can only pick a `cwd` within the invite they are
  already authorized to make, and the connector clamps it to `allowed_roots` regardless.
- **"other" session `cwd`** rides the existing `session_create` gate.

## Plan (phased, dependency-ordered)

Each phase merges and is accepted on its own.

```
Phase 0 ─┬─ Phase 1  (prove per-session cwd end-to-end)
         ├─ Phase 2 ── Phase 3  (on-the-spot validation → invite closes the loop + authz)
         ├─ Phase 4  (additionalDirectories: the mutable lever)
         └─ Phase 5 / Phase 6  (reflect root set into browse / local realize)
```

### Phase 0 — Connector: per-session `cwd` + root-set plumbing (foundation)

- `SessionStartOptions` (`runtime_adapter.rs`): add `additional_dirs: Vec<String>` (keep `cwd`).
- `new_session` / `load_session` in **both** adapters (`acp_adapter.rs`, `acp_runtime.rs`):
  send `"additionalDirectories"`; `load` uses the session's stored `cwd` (not static config).
- `ControlInbound::Task` (`bridge.rs`) + `TaskCommand` (`bridge_runtime/mod.rs`): add
  `cwd: Option<String>`, `additional_dirs: Vec<String>` (`#[serde(default)]`).
- `SessionStartOptions` construction (`bridge_runtime/mod.rs::run_task`): resolve
  `cwd = validate_backend_cwd(task.cwd)` else `default_cwd`; `additional_dirs` = the task
  list filtered through `validate_backend_cwd` (drop out-of-policy entries). **No restart**
  for per-session cwd; `config.cwd`/`current_dir` is only the default/fallback.
- **Accept:** two tasks with different `cwd` → each `session/new` gets the right `cwd`; a
  reused session's `load` keeps the same `cwd`; omitting `additional_dirs` ⇒ root set `[cwd]`.

### Phase 1 — Gateway: choose `cwd` when creating an "other" session (shortest loop)

- `POST .../sessions` (`api/session_control.rs::create_session`): accept optional `cwd`
  (+ later `additional_dirs`); keep the `session_create` gate.
- `create_channel_session` (`domain/sessions.rs`): write `metadata.workspace`.
- `build_task_frame` (`gateway/dispatcher.rs`): read `metadata.workspace` → emit
  `cwd` / `additional_dirs` on the task frame.
- Frontend: a directory picker in the new-session dialog (reuse the workspace browser).
- **Accept:** an "other" session created with `/repo/a` → agent runs in `/repo/a`; none → default.

### Phase 2 — On-the-spot `cwd` validation

- Connector `WorkspaceReq` (`bridge.rs`) gains op `validate_cwd` → `{canonical_path,
  matched_root, is_dir, backend_may_set_cwd}` / errors `E_FORBIDDEN_PATH | E_NOT_FOUND |
  E_NOT_DIR | E_CWD_LOCKED`. Reuse `validate_backend_cwd`.
- Gateway calls it via the existing sync RPC (`api/workspace.rs::workspace_call`) **before**
  persisting; failure → `400` with the reason.
- **Accept:** out-of-root / missing / not-a-dir / cwd-locked → invite rejected on the spot;
  valid → the **canonicalized** absolute path is stored.

### Phase 3 — Invite = `session_create(primary)` + eager platform session + `cwd`

- `add_channel_member` (`api/channels.rs`) for `member_type='bot'`: **AND-gate**
  (`ensure_channel_admin` **and** `acp_policy::allows(..., "cheers/session_create", Initiate)`).
- Accept optional `cwd` / `additional_dirs` → run Phase 2 validation.
- Eagerly upsert the **primary** Cheers session (deterministic
  `cheers:channel:{channel}:bot:{bot}` key, `role='primary'`) + write `metadata.workspace`;
  **do not** contact the connector. Idempotent with the lazy `acquire_scope_session`
  (its `ON CONFLICT DO UPDATE` leaves `metadata` untouched).
- **Accept:** non-owner/unauthorized channel admin inviting someone else's bot → denied;
  authorized invite with a `cwd` → primary exists immediately, first message runs in it.

### Phase 4 — `additionalDirectories` (the mutable lever)

- Frontend + gateway: an "edit accessible dirs" entry (⊆ `allowed_roots`) writing
  `metadata.workspace.additional_dirs`; owner-default + grantable, like set_config.
- Threaded by Phase 0; confirm the connector **resends the full list** every load.
- **Accept:** adding a dir to an existing session takes effect next interaction **without**
  a new session; `cwd` never changes.

### Phase 5 — Reflect the root set into the file browser

- `workspace_req` browse carries session context; root resolution
  (`bridge_runtime/mod.rs`) defaults to the session's `cwd + additional_dirs`, not all
  `allowed_roots` (hard enforcement still `allowed_roots`).
- `RemoteWorkspaceDialog`: entry = session `cwd`; root switcher = session root set.
- **Accept:** the panel shows exactly what the agent may touch for that session.

### Phase 6 — Reflect the root set into local file realize (not the channel axis)

- `RealizeFile` / local-path resolution: resolve against the **session root set**, tightening
  today's "any allowed_root" resolution.
- **Explicitly unchanged:** channel-attachment pull (`inbox_open` bytes) — that is channel
  content addressing, a different axis; the root set does not apply.
- **Accept:** realizing a file inside the root set succeeds; outside it (even if inside
  `allowed_roots`) is rejected; channel-attachment reads are unaffected.

## Non-goals / explicit deferrals

- No mid-session `cwd` change (ACP-forbidden; change = new session).
- No re-pointing a channel's primary to a different session (`set_primary`) — single primary
  + N others already covers the need.
- The agent-side root set stays advisory; we do **not** claim to sandbox the agent's own
  native tools beyond what `allowed_roots` + the connector proxy enforce.
