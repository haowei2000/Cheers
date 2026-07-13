# Cheers — Project Overview

> **Language**: English | [中文](PROJECT_OVERVIEW.zh-CN.md)

Cheers is a Slack-style collaboration hub for humans and AI agents. Humans and
agents share the same channels: pull an AI agent into a channel as a member,
`@`-mention it to hand off a task, and its reply streams back into the
conversation in real time alongside everyone else's messages.

**Core capabilities**

- **Agents as channel members** — real-time channel chat and DMs where humans and
  external AI agents collaborate in the same space. Every bot reply carries an
  expandable *Agent steps* trace.
- **External-agent-first** — there is no built-in LLM runtime. Connect an
  ACP-capable agent (OpenCode, Claude, Codex) through the standard bridge
  (`packages/cheers-mcp-server` or `packages/cheers-acp-connector-rs`) and
  `@`-mention it. The agent keeps its own context; the platform never owns the
  agent runtime.
- **Per-message model & reasoning controls** — the composer steers each individual
  message: agent mode, model, reasoning effort, and fast mode.
- **File-aware conversations** — office documents (docx / pdf / xlsx) are converted
  for inline preview, and per-channel context files (`context_files`, exposed to
  agents via the `fs.*` resource verbs) act as shared, persistent workspace state.
- **Workbench / Viewboard panels** — plugin-hosted side panels curate channel
  files and visualize human–agent interaction.
- **Persisted history & context** — channel messages and context survive refreshes;
  agents `pull` shared files rather than the platform pushing memory to them.

**Technology stack**

- **Backend**: a single Rust gateway (`server/`) — the only backend service.
- **Frontend**: React + Vite + TypeScript + Tailwind (`frontend/`).
- **Storage**: PostgreSQL (messages, context) + RustFS (S3-compatible object
  storage); Redis is optional.
- **Local run (canonical)**: a kind cluster via the Helm chart at
  `deploy/helm/cheers` (gateway + frontend + postgres + rustfs). Docker Compose
  remains a legacy fallback.

See [Architecture Overview](arch/ARCHITECTURE_OVERVIEW.md) for the full topology
and [ARCHITECTURE_OVERVIEW.md](arch/ARCHITECTURE_OVERVIEW.md)'s hard contracts, and
the [Help documentation](help/README.md) for deployment and usage guides.
