# External-Agent-First: no built-in runtime

> **Status**: Design (v1) · **Decided**: 2026-05-31 · **Language**: English default
>
> This document supersedes the earlier "one generic built-in runtime" direction.
> The platform is **external-agent-first**: there is no built-in Python Agent Service.
> Intelligence comes entirely from user-connected ACP agents (OpenCode, Claude,
> Codex, or any ACP-compatible agent). The `cheers-mcp-server` package is the
> standard bridge for MCP-capable agents to participate as ACP bots.

> ⚠️ **Partly superseded — see CURRENT MODEL.** Parts of this doc describe a
> SUPERSEDED model. The dead concepts that still appear here are: the hardcoded
> memory layers (`ANCHOR` / `DECISIONS` / `PROGRESS`) and agent-side "memory
> distillation" as a first-class platform concern. Current model: there is no
> independent `memory` concept; files are the only substrate; Context = the files
> a plugin curates; agents always **pull** (existence announced via system prompt,
> never pushed as body); authorization is **channel-role only**. See the
>「⚠️ CURRENT MODEL (2026-06-23)」declaration at the top of
> [context-and-environment.md](./context-and-environment.md).

---

## 1. The decision

There is no built-in runtime. The platform is a pure protocol/data/routing layer.

| Layer | What it is | Who provides it |
|---|---|---|
| **Platform** | REST API, WS gateway, Agent Bridge, Resource API, mesh routing, DB/S3 | Rust Backend |
| **Intelligence** | LLM reasoning, task execution, ~~memory distillation~~ (⚠️ 历史设计，已废弃 — 见 CURRENT MODEL；文件是唯一基质，无独立 memory 概念) | User-connected external ACP agent |
| **Bridge** | MCP ↔ Agent Bridge translation for MCP-capable agents | `cheers-mcp-server` (stdio) |

A "bot in a channel" is always an external ACP agent connected via a user-owned
connector or the MCP bridge. The platform never has a process of its own that reasons
or calls an LLM.

---

## 2. What is deleted

- All hand-written built-in bot classes (`HttpBot`, `Coordinator`, `Helper`, `HelpBot`)
- The Python Agent Service and its `bot_runtime/` tree
- `trust_level=system` — this trust level existed only for a built-in service; with
  no built-in, it is unused and removed from the trust enum.
  Remaining levels: `trusted > standard > untrusted`.
- Hardcoded memory layers (`ANCHOR` / `DECISIONS` / `PROGRESS`) — now files an
  Environment template seeds, if at all.
  (⚠️ The layered `memory_entries` model these names came from is dead — dropped in
  `0003_decentralized_mesh.sql:89`, replaced by the `context_files` file tree. There is
  no independent memory layer anymore; these are just default Environment-seeded files.
  See CURRENT MODEL.)
- The "one generic runtime + seeded identity" model from the earlier version of this doc.

---

## 3. `cheers-mcp-server` is the standard bridge

`packages/cheers-mcp-server/` (already implemented) is the canonical way for
MCP-capable agents (Claude Code, Codex, Cursor-hosted agents, OpenCode) to act as
ACP bots in the platform.

```
User's machine
  ├─ Claude / Codex / OpenCode   ← the intelligence; calls LLM, reasons, acts
  │       │ MCP stdio
  │       ▼
  │  cheers-mcp-server       ← translates MCP tools/resources ↔ resource_req/res
  │       │ Agent Bridge WS
  │       ▼
Rust Backend                     ← platform; routes tasks, persists messages, fan-out
```

**Why stdio, not remote HTTP MCP:** the agent and the MCP server are co-located on
the same machine; stdio is the most mature and lowest-latency transport. The remote
HTTP MCP path (`backend/app/api/v1/mcp/`) is a second phase for third-party hosts
that cannot run a local process (e.g., Claude.ai web).

**The MCP server does NOT open its own Agent Bridge WS.** It forwards each MCP tool
call over local IPC to the connector, which emits `resource_req` on its existing
data WS and relays the matching `resource_res` back. One bot = one
`(control, data)` WS pair; the MCP server is a translator, not an independent bot.

---

## 4. What "no built-in" means for the product

- **New channel, no agent configured → silent.** `channel.default_bot_id` is unset;
  messages are recorded but no bot is triggered. This is the correct mesh behavior
  ([DECENTRALIZED_MESH §2](./DECENTRALIZED_MESH.md): "no `@` and no default bot →
  silent"). Users configure an agent before expecting bot responses.
- **No `trust_level=system` anywhere.** Anything that previously required system
  trust (automated memory ops, index maintenance) is either a **Rust domain action**
  (no trust level needed — it's internal) or deferred to Phase 3.
- **Deterministic automation is a domain action, not a bot.** If the system needs to
  do something automatically (e.g., summarize a thread on demand), that is a REST
  endpoint / Rust domain action, not an LLM bot call.

---

## 5. Mesh peers come from external agents

The decentralized mesh ([DECENTRALIZED_MESH.md](./DECENTRALIZED_MESH.md)) provides
Bot@Bot chains (A@B@C). With no built-in runtime, all mesh peers are external agents.
This is strictly more general: users compose their own agent topologies by adding
multiple external bots to a channel and letting them `@`-mention each other.

`channel.default_bot_id` remains the "who answers when no `@`" binding — it now
always points to an external agent registered in that channel.

---

## 6. Environment templates still apply

Behavior (mention etiquette, reply format, scenario rules, initial files) is still
delivered via [Environment templates](./context-and-environment.md) — the Seed pours
initial files and a convention prompt into the channel. The agent reads this context
via `channel.context` / `fs.read` exactly as before. The template is data; the
reasoning is the external agent's.

---

## 7. Topology (updated)

```
Browser / Mobile
    │ WS + REST (:8000)
    ▼
┌─────────────────────────────────────────┐
│             Rust Backend                 │
│  REST API · WS Gateway · Agent Bridge   │
│  Resource API · Mesh routing · DB/S3    │
└──────────────┬──────────────────────────┘
               │ Agent Bridge WS (control + data)
    ┌──────────┴──────────┐
    ▼                     ▼
OpenCode / Codex     cheers-mcp-server
(ACP connector)      (MCP ↔ Agent Bridge bridge)
                          │ MCP stdio
                          ▼
                     Claude / Codex / any MCP agent
```

No Python service on the platform side.

---

## 8. Impact on other docs

| Doc | Change |
|---|---|
| [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) | Python Agent Service box removed from topology; `trust_level=system` note removed |
| [ACP_INTEGRATION](./ACP_INTEGRATION.md) | "内置 Agent 定位" row updated; §3 rewritten as external-agent-first |
| [REFACTOR_PLAN](./REFACTOR_PLAN.md) | Phase 1 Python Agent Service checklist removed; effort redirected to Rust mesh schema + resource layer |
| [BOT_PERMISSION](./BOT_PERMISSION.md) | `system` trust level removed from enum; trust ladder is `trusted > standard > untrusted` |
| [DECENTRALIZED_MESH](./DECENTRALIZED_MESH.md) | No change needed — mesh design is agent-agnostic |
