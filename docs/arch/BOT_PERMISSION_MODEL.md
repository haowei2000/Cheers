# Bot Permission Model — ACP-keyed (posture + per-operation authorization)

> The unified permission design for Cheers bots. Builds on
> [BOT_CONFIG_GOVERNANCE.md](./BOT_CONFIG_GOVERNANCE.md) (the L0/L1/L2 sovereignty
> axis) and the ACP method surface. **The ACP operation is the unit of permission.**

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

Approvers (existing `bot↔channel↔user` table) answer *who* may approve when a rule
resolves to `ask` (optionally narrowed per kind later).

## Roles over the bot (management authz)

owner (all) · manager/delegate (subset: set mode within `allowed_modes`, manage
approvers/rules) · approver (resolve `ask`) · user (invoke). Maps onto existing
`ensure_bot_owner_or_admin` + approvers, extended.

## Data model (reuse + one new table)

- L0: connector TOML `policy.*` (exists).
- L1: `bot_accounts` + `binding_config` (permission_mode, model). Optional per-channel: `ChannelMembership.bot_override_config`.
- **Axis B (new):** `bot_permission_rules(bot_id, channel_id, operation_kind, decision)` — `decision ∈ {allow,deny,ask}`; `channel_id=''` bot-wide; `operation_kind='*'` catch-all.
- Approvers: existing table (who resolves `ask`).
- Audit: existing audit events.

## Phasing

1. **Posture plumbing** — L1 persist `permission_mode` + L2 push (clamped by L0). + **resolve the bypass flag** (task #18) so `request_permission` actually fires — this gates everything observable.
2. **Authorization rules** — `bot_permission_rules` table + gateway evaluation at `request_permission` (most-specific-wins) + owner API.
3. **Frontend** — bot permission panel: posture (mode within allowed set) + the per-kind rule grid + approver management.
4. **Verify** — end-to-end: per-kind allow/deny/ask → card → decision.

## Invariants

- Connector stays ACP-generic (opaque modeIds/kinds).
- L0 is the ceiling; L1/L2 only tune within it; rules can be stricter, never exceed L0.
- Default-safe: unknown kind / no rule → `ask` (never silent allow).
