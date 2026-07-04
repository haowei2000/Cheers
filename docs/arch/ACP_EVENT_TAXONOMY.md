# ACP Event Taxonomy — by origin (agent-produced vs user-side)

> **Status: "wire all ACP events into Cheers" — Phases 0–6 complete + verified on kind.**
> 0 registry (`domain/acp_events.rs`) · 1 uniform passthrough (`acp_event` frame +
> `acp_event_log`) · 2 single chokepoint (`domain/acp_policy.rs`) · 3 vocabulary derived
> from the registry · 4 enforcement (prompt/cancel INITIATE, RESPOND; set_mode/set_config
> now GRANTABLE + session-scoped — see [SESSION_MODEL.md](SESSION_MODEL.md); live-SEE read-time)
> · 5 timeline read API + `BotActivitySection` UI · 6 verified
> (matrix renders the full vocab; the timeline shows the live stream classified by home).


> Foundation for the event-centric permission model (agent / connector / Cheers).
> Sources: the live agent `@agentclientprotocol/claude-agent-acp@0.36.1`
> (`dist/acp-agent.js` — authoritative for what flows in practice), the ACP method
> surface, and the Cheers connector bridge protocol (`packages/cheers-acp-connector-rs/src/bridge.rs`).
>
> **Rule of thumb:** *agent-produced* = `agent → client` (the connector relays it to
> Cheers, which shows it to users / collects a response). *user-side* = `client → agent`
> (a user/Cheers action sent down to the agent).

## 1. Agent-produced events (agent → client/Cheers)

### 1a. Streaming output — `session/update` notifications (one-way; nothing to answer)
| Event (`sessionUpdate:`) | Meaning |
|---|---|
| `agent_message_chunk` | assistant text/image output |
| `agent_thought_chunk` | reasoning/thinking |
| `user_message_chunk` | replayed user message |
| `tool_call` | a tool invocation begins — **carries `toolCall.kind`** (read/edit/delete/move/search/execute/fetch/other) |
| `tool_call_update` | tool progress / result / diff / exit code |
| `plan` | task plan / todo state |
| `available_commands_update` | advertised slash/MCP commands |
| `config_option_update` | model/mode/effort changed |
| `current_mode_update` | permission mode changed |
| `usage_update` | tokens / context / cost |
| `_claude/sdkMessage` (ext) | raw SDK debug, opt-in |

### 1b. Agent → client **requests** (agent asks; needs a user-side response)
| Event | Meaning |
|---|---|
| **`session/request_permission`** | the approval ask — the heart of the permission model |
| `fs/read_text_file` | agent asks the client to read a file |
| `fs/write_text_file` | agent asks the client to write a file |

> **claude-agent-acp nuance:** it runs Bash/edits **inside the Claude Code SDK**, so
> *execute/terminal* tool use does **not** surface as ACP `terminal/*` methods — it
> surfaces as `tool_call` + a single `request_permission`. So in practice there is **one
> gate event for every dangerous tool**: `request_permission` (with `toolCall.kind`).

### 1c. Cheers-native bot actions (NOT ACP — bot acting as a channel participant)
Surfaced via the connector's `DataOutbound` frames; treat them as agent-produced too:
| Bridge frame | Meaning |
|---|---|
| `Send` | bot posts a message to a channel |
| `FileUpload` | bot uploads a file |
| `ResourceReq` | bot reads channel resources (members, workspace, …) |
| `Trace` | structured observability event |
| `Delta` / `Done` / `Error` | streaming of the bot's reply |

## 2. User-side events (client/Cheers → agent)

### 2a. Lifecycle / session control
`initialize`, `authenticate`, `session/new`, `session/load`, `session/resume`,
`session/list`, `session/close`, `unstable_forkSession`, `unstable_deleteSession`.

### 2b. The "do something" events
| Event | Meaning |
|---|---|
| **`session/prompt`** | the user prompt — the primary *initiate* event (Cheers bridge: `Task`) |
| `session/cancel` | cancel an in-flight turn (bridge: `Cancel`) |

### 2c. Config / posture (user-side sets agent behavior)
| Event | Meaning |
|---|---|
| `session/set_mode` | permission mode: default / plan / acceptEdits / dontAsk / auto / bypassPermissions |
| `set_config_option`, `unstable_setSessionModel` | model / effort / mode (bridge: `ConfigUpdate`, `ConfigOptionSet`) |

### 2d. Responses to the agent's requests
- the **permission outcome** (response to `request_permission`) — approve/reject (bridge: `PermissionResolution`)
- `fs` read/write results.

## 3. Bridge mapping (Cheers frames ↔ ACP, by origin)
`DataOutbound`/`ControlOutbound` = connector→gateway (**agent-produced**);
`ControlInbound`/`DataInbound` = gateway→connector (**user-side**), except the two
agent-initiated tool-use reads (`RealizeFile`, `WorkspaceReq`).

| Bridge frame | ACP event | Origin |
|---|---|---|
| `DataOutbound::PermissionRequest` | `session/request_permission` | agent |
| `DataOutbound::Delta/Done` | `session/update` (text) | agent |
| `DataOutbound::Send/FileUpload/ResourceReq/Trace` | Cheers-native bot action | agent |
| `ControlInbound::Task` | `session/prompt` | user-side |
| `ControlInbound::PermissionResolution` | permission outcome | user-side |
| `ControlInbound::ConfigUpdate/ConfigOptionSet` | `set_config_option`/`set_mode` | user-side |
| `ControlInbound::RuntimeSessionControl` | `session/new`·`load`·`cancel` | user-side |

## 4. Implication for the three-layer model
- **Connector (host gate):** decides which event *types* may pass at all — e.g. refuse
  `fs/write`, refuse `tool_call` of `kind=execute`. User-independent.
- **Cheers (user policy):** two matrices keyed on **(user/role × event-class)**:
  - **INITIATE** — user-side events: who may `session/prompt` the bot, who may `set_mode`,
    who may cancel. (Most are gated by *who can talk to the bot at all*.)
  - **SEE** — agent-produced events: who may view the bot's output / `tool_call` / `plan` /
    `trace`; and for **`request_permission`**, additionally *who may respond* (= today's
    approvers, generalized).
- **Agent:** owns *when* it asks (its mode) and *what* it emits.

## Enforcement status (complete)

| Capability · event | Enforced where |
|---|---|
| INITIATE · `prompt` | `create_message` (bot trigger) |
| INITIATE · `cancel` | `cancel_message` endpoint |
| RESPOND · `permission_request` | `resolve_permission` (owner ∪ approvers ∪ matrix) |
| SEE · `tool_call`/`plan`/`thought` (persisted) | trace read endpoints (read-time filter) |
| **SEE · live `bot_trace`** | **per-subscriber live filter** — `handle_trace_frame` → `allowed_seers` → `broadcast_channel_to_users` (SEE `tool_call`; approval traces → `permission_request`) |
| **SEE · live `permission_request` card** | **per-subscriber live filter** — `handle_permission_request_frame` filters the card broadcast by SEE; RESPOND still gates who may answer |
| SEE · `output` (bot's chat reply) | **membership-level** — a conversation reply isn't hidden per-member (incoherent, and would mean filtering every token) |
| `set_mode` / `set_config_option` | **deny-default but GRANTABLE** (`OWNER_DEFAULT_INITIATE`). **Bot owner / platform admin are allowed by default**; every other subject is denied unless an explicit INITIATE grant widens it. Owner sets the bot-level default via `PUT /permissions/posture` · `/config-option`; an authorized channel member changes a *session's* mode/config via `POST /channels/:ch/bots/:bot/sessions/:sid/mode` · `/config-option` (fail-closed, value-clamped by L0). They appear in the INITIATE matrix. See [SESSION_MODEL.md](SESSION_MODEL.md). ⚠️ **Changed** — previously excluded/owner-only. |

Per-subscriber SEE: the caller computes the allowed-user set (`allowed_seers`: online users × channel role × bot rules; platform admins bypass; fail-open) and the fanout delivers only to those connections (`broadcast_channel_to_users`, in-process + Redis see-subject). All authorization runs through the single `acp_policy::allows(…)` chokepoint.

> Net: the permission system reduces to **(a) the connector's event-type allow-list** +
> **(b) Cheers's two (user × event) matrices (initiate / see+respond)**. `request_permission`
> is just the one agent event that needs a user response, so "approvers" is the
> see+respond slice of the SEE matrix.
