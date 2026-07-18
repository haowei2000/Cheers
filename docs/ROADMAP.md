# Cheers Roadmap

> **Language**: English | [中文](ROADMAP.zh-CN.md)

The public, product-facing milestone roadmap and current preview status.

This is the English default edition prepared for the open-source documentation set. The full Chinese version is preserved next to this file for readers who prefer Chinese or need the original historical wording.

> For the engineering **execution** plan (milestone-by-milestone build order, acceptance gates, refactor items R1–R14), see [docs/arch/ROADMAP.md](arch/ROADMAP.md) — that is a separate, working engineering document; this file is the public product roadmap.

## Key Topics

- M1 core chat path
- M2 multi-agent collaboration
- M3 Coordinator routing
- Portal phase planning
- Long-term reliability and knowledge-base work

## Current Guidance

- Prefer the English `.md` file as the default public entry point.
- Use the `.zh-CN.md` file as the Chinese mirror.
- For implementation details, verify against the current code and the user/operations documentation first.
- Historical design notes may describe planned features; when in doubt, treat README, `docs/help/`, and the current code as authoritative.

## Strategic Direction

> **Not a better Slack — the governance workspace for agent fleets. Chat is the
> interface; governance is the product.**

Teams are heading toward running 5–20 agents, not one. At that point the hard
questions — who may command which agent, whose budget it spends, who approved
which action, where agents collaborate — can only be answered by the party that
**owns the identity, permission, and audit model**. That is what Cheers builds:
bots as first-class members of Cheers's *own* governance model, not guests inside
someone else's chat app. (Full competitive analysis: [COMPARISON.md](COMPARISON.md).)

Three phases:

1. **Make governance undeniable** — approval UX as smooth as reviewing a PR
   (diff preview, one-click approve/deny, decision recorded to audit); per-bot /
   per-channel **cost budgets** that pause and escalate on overrun (governance,
   not just tracking); **audit export** and retention policy, turning the
   Viewboard trail into a compliance feature for self-hosted enterprises.
2. **Ship an official Slack/Discord bridge as the adoption funnel** — `@` a
   Cheers bot from Slack; work runs in a Cheers channel under full permissions
   and audit; results post back with a link to the full trail. Teams start
   without migrating; the bridge is the funnel, the platform is the product.
3. **Multi-agent orchestration** — a channel as the governed "meeting room"
   where several external agents (ACP/MCP) and humans work under one grant
   matrix, with the Workbench as the shared blackboard and humans as approval
   nodes. As agents commoditize, the scarce layer is the governed space they
   share.

Roadmap filter for new items: **does this make multi-agent governance stronger?**

### Fleet view — follow-ups

The Fleet view (workspace mission control: approvals inbox + bot roster) shipped
its live P2 (`bot_processing` chips, rail approval badge). Recorded next:

- **Bot-to-bot dispatch under the grant matrix** (in progress) — an agent may
  `@` another agent to hand off a subtask, but every such dispatch passes a new
  `dispatch` capability in the `user ▸ group ▸ role ▸ *` matrix (deny wins,
  owner-only default) and is audited. This is the governance edge no bridge can
  match — see [docs/design/BOT_DISPATCH.md](design/BOT_DISPATCH.md).
- **Fleet P3** (recorded, not started) — in-channel mini fleet strip (a compact
  per-channel roster in the work lane) and approvals-inbox filters (by bot / by
  operation kind / by channel).

### Resource context — attachable Cheers resources as agent context

The Cheers-native `@context`: any participant attaches Cheers's own resources
(plan, board, file, message/thread, decisions) as structured context to an agent
invocation — two producers (human manual pick, bot automatic handoff) over one
foundation, with consumer-governed reads. Design:
[docs/design/RESOURCE_CONTEXT.md](design/RESOURCE_CONTEXT.md). Phases:
F0 foundation → F1 human picker → F2 bot handoff → F3 suggested context.

## Near-Term Plans

### UI

- [ ] Unify UI hover states.
- [ ] Fix missing Chinese and English localization coverage.
- [ ] Optimize default options.

### Backend

- [ ] Clean up and organize backend code.
- [ ] Clarify message queue responsibilities and flow.
- [ ] Plan remote bot workspace isolation, including per-bot working directories, permission boundaries, cleanup policy, and deployment/runtime safeguards.

### Features

- [ ] DingTalk integration.
- [x] PWA + Web Push: installable web app; approval requests and @mentions
      reach the approver's lock screen and deep-link back to the pending card.
- [ ] iOS app — **deferred behind the PWA**: revisit only if mobile approval
      usage proves the demand *and* a PWA hard limit (share sheet, widgets,
      push reliability) actually bites.
- [ ] Android app — same gate as iOS.

## Client Strategy & Boundaries

Where each client surface starts and stops. Decided 2026-07 alongside the
PWA/Web Push work; the guiding split: **the gateway is the control plane and
sole source of truth; local machines are the data plane** (see
[arch/ARCHITECTURE_OVERVIEW.md](arch/ARCHITECTURE_OVERVIEW.md)).

### Mobile = consume + approve (PWA, not native)

The mobile jobs are: approve a blocked permission request, glance at running
work, reply when mentioned. All three are covered by the PWA + Web Push
pipeline (`frontend/src/sw.ts`, gateway `infra/web_push.rs`). Measured reality:
message-path transport is 2–10 ms — the wait is model inference — so a native
app buys no meaningful latency, only push/share/widget affordances. Build
native only when a concrete PWA limit blocks a proven usage pattern.

### Desktop = the chat shell + the connector's graphical home

**Status: M0+M1 in progress (`apps/macos`, Tauri v2).** The desktop client
hosts the SAME built frontend as the web deployment (chat shell included —
no UI rewrite), adds tray residency + native notifications (WKWebView has no
Web Push, so nudges arrive over the user-scoped WS), and differentiates as
**the graphical home of the connector daemon**. Its value, in priority order:

1. **Daemon lifecycle (M1, in progress)** — bundle `cce-acp-connector` as a
   sidecar, start-with-app + revive on crash (the macOS answer to the
   systemd-linger pitfall), GUI start/stop/status/logs and TOML editing. This
   converts connector onboarding from ops work into "install an app", and is
   the only item that *requires* a native artifact.
2. **Same-machine fast path (data plane only)** — when the desktop app detects
   a co-located connector, bypass the gateway round-trip for bulk data:
   open/transfer workspace files directly (the local ops already exist in
   `bridge_runtime::handle_workspace_req`; they lack only a local entry point —
   extend `loopback.rs` with a discoverable port+token under `CHEERS_ACP_HOME`),
   attach to live terminal/output streams, and show approval context (command,
   diff) read straight from the local daemon.
3. Tray + global hotkey, "open in local editor" for agent-touched files.

**Red lines** (violating these forfeits the product's core value):

- Messages and permission *decisions* always go through the gateway — never a
  local bypass. Persistence, multi-device sync, other members' visibility, and
  the audit trail all hang off the gateway being the single source of truth.
- No UI rewrite: the desktop shell hosts the same built frontend.
- The same-machine link carries *data* (files, streams, context), not *control*.

## Related Documentation

- [Documentation Home](help/README.md)
- [User Manual](help/使用说明书.md)
- [Engineering execution roadmap](arch/ROADMAP.md)
