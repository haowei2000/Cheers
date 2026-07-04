# Bot Permission Model — ACP-keyed (posture + per-operation authorization)

> The unified permission design for Cheers bots. Builds on
> [BOT_CONFIG_GOVERNANCE.md](./BOT_CONFIG_GOVERNANCE.md) (the L0/L1/L2 sovereignty
> axis) and the ACP method surface. **The ACP operation is the unit of permission.**

## Event-centric model (current direction)

The model is decomposed **by ACP event** (see [ACP_EVENT_TAXONOMY.md](./ACP_EVENT_TAXONOMY.md)),
with one clean question per layer:

- **Agent** — produces agent→client events and consumes the responses; owns *when* it
  asks (its mode) and *what* it emits.
- **Connector** — the host firewall: which ACP **event-types** are let through at all
  (e.g. may `fs/write` pass? may a `kind=execute` tool call pass?). User-independent.
- **Cheers** — two **`(subject × event-class × capability)`** matrices, subject = channel
  **role** (`owner`/`admin`/`member`/`*`) with **per-user overrides**, defaulting from
  **channel membership** (members may INITIATE+SEE; RESPOND is owner/approver-only):
  - **INITIATE** (user→agent): `prompt`, `set_mode`, `cancel` — who may cause it.
  - **SEE** (agent→user): `output`, `tool_call`, `plan`, `trace`, `permission_request` —
    who may view it; **RESPOND** adds, for `permission_request`, *who may answer it*.

Data: `bot_event_access` (migration 0029) + the pure resolver in
`server/src/domain/bot_event_policy.rs`. The older **Axis B** (`bot_permission_rules`,
per `operation_kind` → allow/deny/ask) is reframed as the bot owner's **auto-answer
policy** for `request_permission` (the bot's *behavior*, not per-user); it composes with
the RESPOND matrix (who is asked when the answer is "ask"). The Axis-A posture knob is the
`set_mode` INITIATE event.

## Core principle

Every bot action is an **ACP operation** — a method, or a tool surfaced via
`session/request_permission` (carrying `toolCall.kind`). For each one the system
answers two questions, nothing more:

- **Q1 CAPABILITY** — *can this bot do this operation at all?*
- **Q2 AUTHORITY** — *who authorizes it at runtime?*

We never invent an operation taxonomy: the ACP method / `toolCall.kind` is the key
(opaque strings — agent-specific names live only in per-agent presets).

## Axis A — Capability (Q1): the posture + envelope

Three sovereignty tiers (see governance doc):
- **L0** host TOML `policy.*` — hard allow/deny + bounds per ACP capability; `backend_may_*` marks the platform-tunable slice. (Set-mode envelope: `backend_may_set_mode` + opaque `allowed_modes` — done.)
- **L1** platform-persisted desired values within L0 — per-bot `permission_mode` (ask-per-tool=`default` / plan / acceptEdits / … / bypass) + model/config-options. Stored in `binding_config`.
- **L2** runtime apply — gateway pushes `session/set_mode` / `session/set_config_option`; connector clamps to L0 (`may_set_mode`).

`permission_mode` is the **agent-side** "when does the agent ask?" knob.

## Axis B — Authority (Q2): per-operation_kind rules + approvers

When the agent asks (`session/request_permission`, forwarded by
`policy.permission.forward_to_backend`), the **gateway** decides with a rule keyed
on `(bot, channel, operation_kind)`:

```
request_permission(kind)
  └─ L0 capable? ── no ─▶ deny
       └─ yes ─▶ rule lookup, most-specific first:
                   (bot, channel, kind) ▸ (bot, channel, '*')
                 ▸ (bot, '',      kind) ▸ (bot, '',      '*') ▸ default 'ask'
                   → allow → auto-approve
                   → deny  → auto-reject
                   → ask   → APPROVERS for (bot, channel) → card → human decides
```

This **generalizes** today's binary approvers: a rule's `kind` lets the owner say
"auto-allow `read`, ask for `edit`, deny `execute`" — using ACP's own
`toolCall.kind` vocabulary. `'*'` = catch-all; `channel=''` = bot-wide default.

Approvers answer *who* may approve when a rule resolves to `ask`. **The "who" is
scoped per operation kind:** the existing `bot↔channel↔user` approvers table gains
an `operation_kind` column (`'*'` = all kinds — today's behavior). So the owner can
grant "Alice may approve `edit`, Bob may approve `execute`."

## The owner page — per-ACP-operation permission matrix

The bot owner gets one page that, **per ACP operation**, controls the decision and
*who* may approve. Two sections:

- **Posture (Axis A):** the bot's `permission_mode` (ask-per-tool=`default` / plan /
  acceptEdits / …), pickable only within the L0 `allowed_modes`.
- **Operation matrix (Axis B):** one row per `operation_kind` the bot uses, each with
  a **decision** (allow / deny / ask) and, when `ask`, the **approver list** (which
  users may approve that operation). `'*'` row = the default for any other kind.

```
 Operation (kind)   Decision      Approvers (when "ask")
 ───────────────    ─────────     ──────────────────────
 read               [ allow ▾ ]   —
 edit               [ ask   ▾ ]   [ Alice ✕ ] [ + add ]
 execute            [ ask   ▾ ]   [ Bob ✕ ]   [ + add ]
 delete             [ deny  ▾ ]   —
 *  (any other)     [ ask   ▾ ]   [ owner ]   [ + add ]
```

Writes go to `bot_permission_rules` (decision) + the per-kind approvers (who); reads
hydrate from both. Owner/admin only (`ensure_bot_owner_or_admin`).

## Roles over the bot (management authz)

owner (all) · manager/delegate (subset: set mode within `allowed_modes`, manage
approvers/rules) · approver (resolve `ask`) · user (invoke). Maps onto existing
`ensure_bot_owner_or_admin` + approvers, extended.

## Data model (reuse + one new table)

- L0: connector TOML `policy.*` (exists).
- L1: `bot_accounts` + `binding_config` (permission_mode, model). Optional per-channel: `ChannelMembership.bot_override_config`.
- **Axis B (new):** `bot_permission_rules(bot_id, channel_id, operation_kind, decision)` — `decision ∈ {allow,deny,ask}`; `channel_id=''` bot-wide; `operation_kind='*'` catch-all. ✅ table + resolution built.
- Approvers: existing `bot↔channel↔user` table **+ new `operation_kind` column** (`'*'` = all) — the per-operation "who".
- Audit: existing audit events.

## Phasing

1. **Posture plumbing** *(mostly done; one blocker)* — ✅ L1 persists the desired mode in `binding_config.connector_control.agentNativePermissionMode`; owner API `GET` (returns `posture{agent_type,permission_mode,allowed_modes}`) + `PUT /bots/:id/permissions/posture` (validated against L0 `allowed_modes`); ✅ L2 push — the gateway sends a `config_update` frame on owner change **and** connect-sync after `hello`; the connector clamps `agentNativePermissionMode` with **both** L0 gates (`backend_may_set_native_options` AND the `allowed_modes` envelope, defense-in-depth) then applies via `session/set_mode`; ✅ frontend "Agent posture" dropdown in `BotPermissionsDialog`.

   **Bypass-flag correction (task #18 — was a misdiagnosis):** reading
   `claude-agent-acp@0.36.1` `canUseTool`, `allowDangerouslySkipPermissions: ALLOW_BYPASS`
   does **not** skip prompts — it only makes `bypassPermissions` an *available mode*. The
   real gate is `if (currentModeId === "bypassPermissions") allow;`; for every other mode
   (`default`/`acceptEdits`/`plan`/`dontAsk`) it calls `requestPermission` → our card fires.
   So nothing in the external package needs patching: the fix is to *actively set the mode to
   `default`* (the posture plumbing above) and keep `bypassPermissions` out of `allowed_modes`
   (the claude preset already does). Remaining: an **e2e confirmation** (task #22) with the
   host connector rebuilt on these changes — a live tool-use should now surface a card.
2. **Authorization rules** ✅ done — `bot_permission_rules` table + most-specific resolution; per-kind **approvers `operation_kind`** column (`*`=any); gateway evaluation wired into `request_permission` (`allow`→auto-approve, `deny`→auto-reject, `ask`→approvers card); owner API for rules (`GET/PUT/DELETE /bots/:id/permissions[/rules]`) and kind-aware approvers (`POST/DELETE /bots/:id/approvers`).
3. **Owner page** ✅ done — `BotPermissionsDialog`: scope selector (bot-wide / per-channel) + the per-operation matrix (decision dropdown + per-kind approver chips). Opened from the bot card's **权限** button (owner/admin only).
4. **Verify** ✅ — proven end-to-end on the live stack (kind gateway + host connector @ 0.36.1, posture=default):
   - A live `Write` tool-use → `session/request_permission` fired → gateway created a pending card (`tool.kind=edit`) → resolved `allow` → the agent proceeded and **wrote the file**, card marked `resolved`. (Same action that previously deleted files with no card.)
   - Bot-wide rule `edit=deny` → next write **auto-rejected** (`auto=true, chosen_kind=reject_once`, gateway "auto-resolved by Axis-B rule"), no human prompt, file never created.
   - Owner API: rules CRUD + `400` on a bad decision; kind-scoped approver grant/list/revoke; posture GET/PUT + `400` on a non-allowed mode (bypassPermissions); matrix + posture UI render.

## Invariants

- Connector stays ACP-generic (opaque modeIds/kinds).
- L0 is the ceiling; L1/L2 only tune within it; rules can be stricter, never exceed L0.
- Default-safe: unknown kind / no rule → `ask` (never silent allow).
