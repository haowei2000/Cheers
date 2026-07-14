# Cheers vs. the AI-collaboration landscape

> **Language**: English | [中文](COMPARISON.zh-CN.md)

Where Cheers sits among the open-source projects that put humans and AI agents in
the same conversation. This is meant to help you pick the right tool — including
picking something *other* than Cheers when it fits you better.

> **Honesty note.** This table reflects each project's **public positioning as of
> 2026-07** and is best-effort, not a benchmark. Cells marked "—" mean *not a
> documented focus*, not *impossible*. Corrections are welcome — open a PR against
> this file.

## Two camps: platform vs. bridge

The single most useful distinction in this space is **who owns the chat surface**:

- **Platform** — the project *is* the chat app. Humans and agents live in channels
  it renders and stores. You adopt a new place to talk. *(Cheers, ChatClaw,
  OpenAgents, OpenSail)*
- **Bridge** — the project routes `@agent` mentions from a chat app you already use
  (Slack, Discord, GitHub threads) to a coding agent, then posts results back. You
  keep your existing tools. *(OpenAB, OpenTag, Kortny)*

Bridges have **lower adoption friction** — your team never leaves Slack. Platforms
give you **control of the surface** — peer-level membership for bots, a permission
and audit layer you own, and shared state that isn't a guest inside someone else's
app. Cheers is a **platform**, and specifically the rare one that is also
**external-agent-first** (agents connect over ACP/MCP rather than being baked in).

## At a glance

| Project | Camp | Agent protocol | Bots as peer members | Fine-grained permissions | Approvals + audit | Shared file workspace | Backend | Self-host | License |
|---|---|---|---|---|---|---|---|---|---|
| **Cheers** | Platform | **ACP + MCP** (external-first) | ✅ channel members | ✅ per-capability grant matrix | ✅ Viewboard audit + approvals | ✅ Workbench (`board.json` → kanban) | **Rust** (Axum/SQLx) | ✅ | MIT |
| ChatClaw | Platform | OpenAI-compatible / OpenClaw | ✅ group chat | — | — | — | — | ✅ | — |
| OpenAgents | Platform | multi-agent network | ✅ shared threads | — | — | ✅ shared files/browser | — | ✅ | — |
| OpenSail | Platform + workflow | MCP | partial (workflow-centric) | ✅ | ✅ approval gates + run history | ✅ sandboxed workspace | Tauri/desktop | ✅ | open-source |
| OpenAB | Bridge | **ACP** | partial¹ (session identity in host app) | allowlists only | — | — | **Rust** | ✅ | MIT |
| OpenTag | Bridge | routes to Codex / Claude Code | n/a (host threads) | ✅ capability checks | ✅ work ledger | — | — | ✅ | open-source |
| Kortny | Bridge | Composio tools | n/a (lives in Slack) | partial (channel/tool scope) | ✅ per-task cost accounting | sandbox artifacts | — | ✅ | Apache-2.0 |

¹ **A nuance worth being fair about.** OpenAB's own docs describe agents as
first-class members with persistent identity — per-thread sessions, lifecycle
management, and bot-to-bot messaging (`[[reply_to:id]]`) in multi-bot channels.
That is real, and it is first-class at the **runtime/session layer**. The
difference is *whose member model the identity lives in*: an OpenAB agent is a
guest inside Discord/Slack's membership and permission system, while a Cheers bot
is a member of **Cheers's own** governance model — the same one humans use, under
the same grant matrix. First-class *process* vs. first-class *member*.

*Academic references worth reading:* **ChatCollab** (Stanford,
[arXiv:2412.01992](https://arxiv.org/abs/2412.01992)) argues humans and AI should
join a collaboration as **equal participants** — a direct research grounding for
Cheers's "bots are first-class channel members" design. **Aleena**
([arXiv:2607.08043](https://arxiv.org/abs/2607.08043v1)) explores decision/alignment
memory across the project lifecycle.

## What makes Cheers different

Three things, in order of how distinctive they are:

1. **Platform *and* external-agent-first.** Most platforms speak their own or an
   OpenAI-compatible protocol; most ACP projects are bridges that don't own a
   surface. Cheers is the intersection — a self-hosted, Slack-style surface that
   agents join over **ACP/MCP**. That combination is genuinely uncommon.
2. **The deepest permission model in the field.** Every bot is governed by a
   permission-grant matrix — who may message it, cancel its tasks, change its
   settings, write files remotely, or answer its approval requests — targeting a
   user, group, or role with precedence `user ▸ group ▸ role ▸ *`, deny wins ties,
   sensitive capabilities owner-only by default. See
   [Bot Permission & Trust](arch/BOT_PERMISSION.md).
3. **Observability + shared work surface as first-class UI.** The **Viewboard**
   (Plan / Cost / Sessions / Audit / Activity) keeps a permanent record of every
   command an agent ran and who approved it; the **Workbench** is a shared file
   tree that renders structured files live (a `board.json` becomes a kanban board)
   for humans and agents to edit together.

## Where Cheers is behind today

Stated plainly, so you can plan around it:

- **Adoption and mindshare.** Cheers is an early public preview. Several projects
  above have more stars, more integrations, and more battle-testing right now.
- **Onboarding friction.** If your team already lives in Slack, a **bridge**
  (OpenAB / OpenTag / Kortny) lets an agent join *today* without moving anyone.
  Cheers asks you to adopt a new surface — worth it for the control and audit, but
  it is a real cost.
- **Approvals + audit are not unique.** OpenSail and OpenTag also do
  approvals/ledgers. Cheers's edge there is **granularity** and that the audit
  lives in the surface you own — not that it invented the idea.

## When to pick something else

- **You want an agent inside your existing Slack/Discord, minimal setup** →
  [OpenAB](https://github.com/openabdev/openab) (Rust, ACP),
  [OpenTag](https://github.com/amplifthq/opentag) (Slack + GitHub threads), or
  [Kortny](https://www.kortny.dev/) (Slack coworker).
- **You want workflow automation with approval gates and scheduling** →
  [OpenSail](https://github.com/TesslateAI/OpenSail).
- **You want a desktop multi-agent "virtual company" chat** →
  [ChatClaw](https://github.com/fastclaw-ai/chatclaw) or
  [OpenAgents](https://github.com/openagents-org/openagents).
- **You want a self-hosted collaboration *platform* where bots are peer members
  under a fine-grained permission + audit layer you own** → Cheers.
