# MCP Cheers: Bots vs. Regular Users

> **Language**: English | [中文](mcp-bot-vs-user.zh-CN.md)

Cheers is **external-agent-first**: it ships no built-in AI. Intelligence comes from an
external ACP agent (Claude, Codex, OpenCode, …) that you connect yourself. This page
explains how that agent reaches into a channel through the **Cheers MCP server**, and —
the part most people ask about — **how a bot is the same as, and different from, a
regular human user** inside the system.

If you are wiring up an agent for the first time, read
[Agent Bridge Integration Guide](AgentBridge接入指南.md) and
[Local Bot Setup Guide](本地Bot配置指南.md) first; this page is the conceptual companion.

---

## 1. What "MCP Cheers" is

Cheers exposes a **native HTTP MCP endpoint** at the canonical URL advertised
by the authenticated Gateway hello. The Connector injects that URL into every
ACP session with empty headers; the Agent owns OAuth discovery, consent, token
storage, refresh, and revocation handling. There is no local stdio MCP process
or Connector OAuth proxy.

The full chain looks like this:

```
External ACP agent (Claude / Codex / OpenCode)
        ↕  HTTPS MCP + native OAuth
Rust gateway /mcp

External ACP agent
        ↕  ACP (local stdio)
ACP connector daemon  (cce-acp-connector)
        ↕  Agent Bridge WebSocket  (control + data)
Rust gateway  (the only backend)
```

So MCP is the **read/act surface** the agent uses to see and touch a channel; the **Agent
Bridge WebSocket** transports prompts and streaming. MCP uses a separate OAuth
host identity and the Gateway rechecks channel authorization per call.

---

## 2. The MCP tool surface

Every channel-scoped tool takes a `channel_id`. Server-side
channel-membership **role checks still apply** to every call — the MCP server does not grant
any power the bot's channel role does not already have.

> The authoritative surface is the shared catalog in
> `packages/cheers-mcp-server/src/tools.rs`.

**Read-only**

| Tool | Purpose |
|---|---|
| `get_channel_info` | Channel metadata: name, type, workspace |
| `list_members` | Members of the channel — **both users and bots** |
| `read_messages` | Read messages by pagination or `channel_seq` cursor |
| `messages_index` | `min_seq` / `max_seq` / `count` for finalized messages |
| `messages_by_seq` | Fetch finalized messages in a `channel_seq` range |
| `search_messages` | Case-insensitive substring search over message content |
| `read_activity` | Unified `channel_seq` event stream (messages + channel ops) |
| `get_context` | Condensed channel context bundle (topic / pinned / summary) |
| `artifact_list` / `artifact_get` / `artifact_read` | List all channel outputs, inspect availability and read by stable artifact ID |
| `desk_list` / `desk_read` | Legacy source-path access, including configuration and directory browsing |

**Write / role-gated**

| Tool | Purpose |
|---|---|
| `post_message` | Send a message; supports `mention_ids` / `mention_names` and reference cards |
| `leave_channel` | Remove self from a channel; not allowed in DMs |
| `artifact_create` | Create a document, HTML/TSX page or canvas; reuse `idempotency_key` for retries |
| `artifact_update` | Edit text by artifact ID with the returned artifact `if_version` |
| `artifact_deliver` | Deliver a binary file (base64, ≤ 8 MB); reuse `idempotency_key` for retries |
| `desk_write` / `desk_edit` / `desk_append` | Legacy path-based operations; use artifact tools for new generated content |
| `desk_rm` / `desk_mv` | Legacy removal / move of source files or subtrees |

Documents, uploaded files, pages and canvases share the channel's **Artifacts**
library. They are channel resources subject to membership and role checks, not a
private Bot workspace. Host workspace files stay remote until explicitly delivered.
Cards display references to artifacts; they do not create another content copy.

Use the `artifact.uri` returned by creation or delivery in replies and
`resource_ref` cards. For example, after creating `report.html`, send
`{"v":1,"kind":"resource_ref","uri":"cheers:artifact/<returned-id>","title":"Report"}`
inside `post_message.cards_json`. Use the actual returned ID, never the path or a
made-up ID. For edits, read the current artifact version first; handle a version
conflict by re-reading before applying changes. Check availability: metadata for
an expired attachment does not restore its bytes.

`inbox_list`, `inbox_open` and `inbox_deliver` remain callable for existing clients
but are no longer advertised in `tools/list`. Legacy Desk/Inbox links still open;
new replies should use canonical artifact links. Directory and source operations
remain available until their consumers migrate.

MCP resource templates follow the same model: `/artifacts` lists outputs,
`/artifacts/{artifact_id}` reads content, and `/artifacts/{artifact_id}/metadata`
checks availability and version. These paths follow `cheers://channel/{channel_id}`.
The `review_artifact` prompt takes `channel_id` and `artifact_id`; existing
`review_attachment` calls remain supported but are no longer advertised.

---

## 3. How a bot authenticates

Prompt transport authenticates on the **Agent Bridge WebSocket**. MCP calls use
the Agent's native OAuth lifecycle and a host-bound access token; the
Gateway validates host state, scopes, audience, and channel membership
on every call. The Bridge credential model remains:

1. **Identity first.** `POST /api/v1/bots` creates only the durable Bot identity.
2. **Host creation.** `POST /api/v1/bots/{bot_id}/hosts` creates a pending
   device Host and returns a 900-second, single-use pairing code.
3. **Pairing.** `POST /api/v1/hosts/redeem` authenticates by that code, activates
   the Host, and returns an `agbi_…` credential once. Only its SHA-256 is stored.
4. **Handshake.** Agent Bridge accepts the Host credential only when its Host
   is active and not revoked and the Bot is enabled.

Because the credential is high-entropy and random, an **unsalted SHA-256** at rest is correct here
(no bcrypt needed).

---

## 4. Bots vs. regular users — the core of it

Cheers deliberately keeps **two separate identity tables** — it does **not** merge bots into
the users table — because a bot and a user carry different responsibility. A bot is always
**owned** by a user (`bot_accounts.created_by`) and is a *tool*, never a fully independent
principal.

| | Regular user | Bot |
|---|---|---|
| **Identity table** | `users` | `bot_accounts` (owned by a user via `created_by`) |
| **How it logs in** | username + password → JWT | `agb_` token → Bearer / auth-frame on the Bridge WS |
| **Global platform role** | `users.role` (`system_admin` / `admin` / `member`) | **None** — a bot has no platform-wide role |
| **Channel role** | `owner` / `admin` / `member` / `readonly` | **Capped at `member` / `readonly`** — a bot can never own or admin a channel |
| **Liveness (presence)** | online = has a browser WS subscription | online = its connector's **both** control **and** data WS are up |
| **Kill switch** | account delete / disable | `is_disabled` flag blocks its bridge instantly |
| **Extra permission machinery** | — | `bot_permission_rules`, event-access policy, ACP capability delegations, session plans |

### What is **the same** (the polymorphic relation layer)

Above the two identity tables, everything relational is shared and keyed by
`(member_id, member_type)` where `member_type ∈ {'user', 'bot'}`. So a bot is a
**first-class member**, not a bolted-on special case:

- **Membership** — one `channel_memberships` table. Bots are invited through the **same**
  unified invite picker as users (`search_invitable` returns users and bots together), just
  with an extra authorization gate (platform admin / bot owner / holder of the bot's
  `cheers/session_create` grant — fail-closed).
- **Messages** — one `messages` table; `sender_type` is just `"user" | "bot" | "system"`.
- **Mentions** — one `message_mentions` table, also keyed by `member_type`. You @-mention a
  bot exactly like a person; mentioning a bot is what **triggers it to act**. Agents mention
  by **name** (`mention_names`, resolved server-side to UUIDs); the UI uses `mention_ids`.
- **Presence** — one unified roster. `broadcast_presence()` emits a single frame with both
  `online_user_ids` and `online_bot_ids`; only the *liveness source* differs (see table).

### What is **different** (responsibility & control)

- **No independence.** A bot's actions always trace back to its owner (`created_by`); the
  audit layer never lets a bot be truly independent. The UI may *present* a bot as a
  first-class member, but accountability flows to a human.
- **Capped authority.** A bot tops out at channel `member` / `readonly` — it cannot own or
  administer a channel, and it carries no platform role.
- **Extra guard rails.** Bots have permission machinery users don't: per-bot permission
  rules, event-access policy, ACP capability delegations, and session plans. See
  [BOT_PERMISSION.md](../arch/BOT_PERMISSION.md) and the bot-permission suite under `docs/arch/`.

---

## 5. One-line mental model

> A **bot** is a *first-class member of a channel* (it posts, is mentioned, has presence, can
> be invited and can leave — all through the same tables as a person) but a *second-class
> principal of the platform* (owned by a user, no platform role, channel authority capped at
> member/readonly, and killable at any time). The **Gateway HTTP MCP endpoint** is the tool surface
> that lets the owner's external agent see and act inside the channels its bot belongs to.

---

## Related

- [Agent Bridge Integration Guide](AgentBridge接入指南.md) — registering a bridge bot
- [Local Bot Setup Guide](本地Bot配置指南.md) — the connector daemon and per-bot TOML
- [Architecture Overview](../arch/ARCHITECTURE_OVERVIEW.md) — system topology
- Bot permission model: [BOT_PERMISSION.md](../arch/BOT_PERMISSION.md)
