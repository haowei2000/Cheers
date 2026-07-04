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

`cheers-mcp-server` is a small local **stdio MCP server** (a single Rust binary). It does
**not** talk to your agent's model and is **not** something a bot connects to over the
network. Instead, the **ACP connector daemon** (`cce-acp-connector`) spawns it as a child
process and hands it a few environment variables so it knows which channel it is acting in:

| Env var | Meaning |
|---|---|
| `CHEERS_RESOURCE_URL` | Loopback endpoint back into the connector |
| `CHEERS_RESOURCE_TOKEN` | Optional bearer for that loopback |
| `CHEERS_CHANNEL_ID` | Default channel the tools act on |
| `CHEERS_BOT_ID` | Which bot identity is acting |
| `CHEERS_SESSION_ID` | Current bridge session |
| `CHEERS_REQUEST_TIMEOUT_MS` | Per-call timeout |

The full chain looks like this:

```
External ACP agent (Claude / Codex / OpenCode)
        ↕  ACP (stdio)
ACP connector daemon  (cce-acp-connector)
        ↕  Agent Bridge WebSocket  (control + data)
Rust gateway  (the only backend)
        ↑
        └── connector also spawns cheers-mcp-server (stdio),
            which pulls channel resources back through the connector's loopback
```

So MCP is the **read/act surface** the agent uses to see and touch a channel; the **Agent
Bridge WebSocket** is the transport and the place where the bot actually authenticates.

---

## 2. The MCP tool surface

Every tool takes an optional `channel_id` (it falls back to `CHEERS_CHANNEL_ID`). Server-side
channel-membership **role checks still apply** to every call — the MCP server does not grant
any power the bot's channel role does not already have.

> The package README's older tool list (`list_files` / `read_file` / `fs_*`) is **stale**.
> The authoritative surface is the source (`packages/cheers-mcp-server/src/main.rs`).

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
| `inbox_stage` | Register a local path as a lazily-delivered staged attachment |
| `desk_write` / `desk_edit` / `desk_append` | Create / edit / append a desk file (optimistic lock via `if_version`) |
| `desk_rm` / `desk_mv` | Remove / move a desk file or subtree |

Two file spaces to keep straight (baked into the MCP initialize prompt):

- **INBOX** (`inbox_*`) — **read-only**, human-uploaded files, addressed by `file_id`.
- **DESK** (`desk_*`) — the bot's **private, editable** workspace, addressed by `path`.

---

## 3. How a bot authenticates

Authentication does **not** happen through the MCP server — it happens on the **Agent Bridge
WebSocket**. The token model:

1. **Minting.** `generate_bot_token()` mints an `agb_<hex>` token. The plaintext is returned
   **once**; only its **SHA-256** is stored, in `bot_accounts.bot_token_hash` (plus a
   display-only `bot_token_prefix`). Re-issuing rotates it and invalidates the old one.
2. **One minting path.** `mint_bot_token()` is the only code that creates tokens. It has two
   entry points:
   - `POST /api/v1/bots/{bot_id}/token` — manual issue/rotate, gated to the bot's **owner or
     an admin**.
   - **Enrollment redeem** — `POST /api/v1/bots/{bot_id}/enrollment` mints a one-time,
     900-second, single-use **enrollment code**; `POST /api/v1/enrollment/redeem` (the only
     unauthenticated endpoint — it authenticates *by the code itself*) swaps that code for a
     bot token. This is the smooth onboarding path a connector uses.
3. **Handshake.** On the Bridge WS, the control channel prefers an
   `Authorization: Bearer <token>` header; if absent, it accepts a first JSON `auth` frame
   carrying the token.
4. **Verification.** `resolve_bot()` hashes the presented token and looks up
   `bot_accounts WHERE bot_token_hash = $1`. A bot flagged `is_disabled` (the admin
   kill-switch) is rejected as `BotUnavailable`.

Because the token is high-entropy and random, an **unsalted SHA-256** at rest is correct here
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
> member/readonly, and killable at any time). The **MCP server** is simply the tool surface
> that lets the owner's external agent see and act inside the channels its bot belongs to.

---

## Related

- [Agent Bridge Integration Guide](AgentBridge接入指南.md) — registering a bridge bot
- [Local Bot Setup Guide](本地Bot配置指南.md) — the connector daemon and per-bot TOML
- [Architecture Overview](../arch/ARCHITECTURE_OVERVIEW.md) — system topology
- Bot permission model: [BOT_PERMISSION.md](../arch/BOT_PERMISSION.md)
