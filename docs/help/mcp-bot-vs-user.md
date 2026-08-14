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
installation identity and the Gateway rechecks channel authorization per call.

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
| `inbox_list` / `inbox_open` | List / open human-uploaded chat attachments by `file_id` |
| `desk_list` / `desk_read` | List / read the bot's own workspace ("desk") files by path |

**Write / role-gated**

| Tool | Purpose |
|---|---|
| `post_message` | Send a message; supports `mention_ids` / `mention_names` to @-mention members |
| `leave_channel` | Remove self from a channel (like a human leaving); not allowed in DMs |
| `inbox_deliver` | Post a new file (base64, ≤ 8 MB) into the channel as an attachment |
| `desk_write` / `desk_edit` / `desk_append` | Create / edit / append a desk file (optimistic lock via `if_version`) |
| `desk_rm` / `desk_mv` | Remove / move a desk file or subtree |

Two file spaces to keep straight (baked into the MCP initialize prompt):

- **INBOX** (`inbox_*`) — **read-only**, human-uploaded files, addressed by `file_id`.
- **DESK** (`desk_*`) — the bot's **private, editable** workspace, addressed by `path`.

---

## 3. How a bot authenticates

Prompt transport authenticates on the **Agent Bridge WebSocket**. MCP calls use
the Agent's native OAuth lifecycle and an installation-bound access token; the
Gateway validates installation state, scopes, audience, and channel membership
on every call. The Bridge credential model remains:

1. **Identity first.** `POST /api/v1/bots` creates only the durable Bot identity.
2. **Installation creation.** `POST /api/v1/bots/{bot_id}/installations` creates a pending
   device Installation and returns a 900-second, single-use pairing code.
3. **Pairing.** `POST /api/v1/installations/redeem` authenticates by that code, activates
   the Installation, and returns an `agbi_…` credential once. Only its SHA-256 is stored.
4. **Handshake.** Agent Bridge accepts the Installation credential only when its Installation
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
