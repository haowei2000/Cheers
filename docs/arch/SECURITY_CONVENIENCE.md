# Security & Convenience: the three planes

> Status: **partially adopted** — 2026-08-22. Web session step-up is adopted in migration
> `0095` and the unified auth-flow API. Personal Host posture and collaboration invoker
> intersection remain proposals. Sections label proposal-only behavior explicitly.
> Companions: [SECURITY](./SECURITY.md) (transport / device auth / E2EE baseline) ·
> [BOT_PERMISSION_MODEL](./BOT_PERMISSION_MODEL.md) (the ACP-keyed model) ·
> [PLATFORM_RESOURCE_PERMISSION](./PLATFORM_RESOURCE_PERMISSION.md) (non-ACP resource ops) ·
> [MCP_AGENT_SECURITY](./MCP_AGENT_SECURITY.md) (agent-side topology)

## The question

Cheers has three surfaces: the **Web** client, a **Personal Bot/Host** (the connector
running on someone's own machine), and **collaboration** (shared channels, delegated bots,
bot@bot chains). How do we make all three secure *and* convenient?

## The principle

The three surfaces do not share a threat model, so they should not share a mechanism. What
they should share is **where the cost is paid: once, at a boundary crossing — not per
action.**

Any design where the user pays per-action trains them to click "allow" without reading.
**Approval fatigue is a security failure, not a UX complaint.** Treat "how often is a human
interrupted" as a hard budget, the way you'd treat a latency budget.

| Plane | What is actually at risk | The convenience currency |
|---|---|---|
| **Web** | identity / session | never type a password |
| **Personal Bot/Host** | the owner's **machine** (blast radius) | never hand-edit a TOML |
| **Collaboration** | **delegated authority** (confused deputy) | never approve routine things |

---

## 1. Web plane — identity

### Adopted state

This plane now has an adopted in-session step-up boundary. The remaining OAuth fresh-auth
handoff is intentionally fail-closed, as described below.

| Property | Where |
|---|---|
| 10-minute access tokens (RS256, `kid` for rotation) | [`domain/auth.rs:18`](../../server/src/domain/auth.rs) |
| Refresh rotation with **reuse detection → whole session revoked** | [`domain/auth_sessions.rs:340`](../../server/src/domain/auth_sessions.rs) |
| `HttpOnly; Secure; SameSite=Lax` cookies + CSRF token hash | [`api/auth.rs:256`](../../server/src/api/auth.rs) |
| `token_version` for account-wide revoke; `is_suspended` check on load | [`domain/auth.rs`](../../server/src/domain/auth.rs) |
| Passkeys (WebAuthn), TOTP 2FA, trusted devices | [`domain/webauthn.rs`](../../server/src/domain/webauthn.rs), [`domain/two_factor.rs`](../../server/src/domain/two_factor.rs) |
| In-session step-up: fixed 15-minute window, bound to the current session | [`domain/auth_sessions.rs`](../../server/src/domain/auth_sessions.rs), [`api/auth_flow.rs`](../../server/src/api/auth_flow.rs) |
| Passkey-first confirmation with password, TOTP/recovery, and constrained email fallback | [`features/auth/StepUpDialog.tsx`](../../frontend/src/features/auth/StepUpDialog.tsx) |
| Structured `428 recent_authentication_required`, shared modal, one automatic retry | [`api/client.ts`](../../frontend/src/api/client.ts), [`lib/stepUpCoordinator.ts`](../../frontend/src/lib/stepUpCoordinator.ts) |

### Step-up boundary

Step-up is spent only where authority grows or a reusable credential is issued: pairing
codes, Host activation/credential rotation, Bot token issuance, new capability or approver
delegation, allow rules, identity/Passkey/TOTP enrollment, and removal of the last strong
sign-in method. Revocation, deny rules, deleting allow rules, ordinary reads, audit, and ACP
runtime preferences remain available without interruption. Deleting a deny rule is treated
as authority growth.

The transaction expires after ten minutes, is limited to five failures, is bound to
`user_id + session_id`, and is consumed once. Successful verification updates only
`step_up_at`; it does not rotate the refresh token, replace the macOS Keychain session,
clear Query Cache, or discard drafts. Trusted Device never bypasses this boundary.

Legacy login endpoints remain available for older macOS clients while callers move to the
unified flow contract. Removing them is a separate release gate after the minimum supported
desktop version advances.

Password, email OTP, TOTP/recovery code, and Passkey login use the unified transaction.
Existing Apple/Google/GitHub login remains on the compatible OAuth handoff. OAuth is not
advertised as a step-up method yet: enabling it requires a popup or system-browser callback
that binds the provider subject to the original `user_id + session_id + transaction_id`.
Google/Apple must also force provider reauthentication; GitHub cannot independently satisfy
step-up when freshness cannot be proven. Falling back to a registered local factor is the
fail-closed behavior until that handoff lands.

---

## 2. Personal Bot/Host plane — blast radius

### Two invariants worth writing down

These are the best decisions in the system. State them so they are not eroded by a later
convenience patch:

1. **The agent holds no credentials.** The connector owns the bot token; the LLM only
   expresses intent ([MCP_AGENT_SECURITY](./MCP_AGENT_SECURITY.md) §3). This is what makes
   prompt injection *survivable* — an injected agent cannot exfiltrate what it never held.
2. **L0 is the machine owner's floor, and the platform cannot raise it.** `allowed_roots`,
   `git_ops`, prompt caps, env allowlist live in the connector TOML
   ([`config.rs:111,147`](../../packages/cheers-acp-connector-rs/src/config.rs)); the
   backend may only narrow within it.

Supporting current state: the pairing code is single-use, 15-minute, per-bot and per-owner
capped, and **every failure mode returns the same opaque 400** so it is not an existence
oracle ([`api/pairing.rs:41,268`](../../server/src/api/pairing.rs)). Session roots are a
strict narrowing (`session_roots ∩ allowed_roots`) with `..` escapes rejected
([`bridge_runtime/mod.rs:884-911`](../../packages/cheers-acp-connector-rs/src/bridge_runtime/mod.rs)).

### Gap A — L0 is a file, not a posture

The security of this whole plane rests on the user getting `allowed_roots` right, in a TOML
they hand-write. That is the inconvenience that actually *costs* security: people widen it
to `["~"]` once and never revisit.

**Proposed:** make L0 a **posture chosen at pairing time**. The redeem flow already returns
a generated config ([`api/pairing.rs:268`](../../server/src/api/pairing.rs)) — have it take
a posture and emit the roots:

| Posture | `allowed_roots` | `git_ops` | Permission forwarding |
|---|---|---|---|
| Read-only | one project dir | `Read` | forward everything |
| This project | one project dir | `Read` | auto-allow reads, forward writes/execute |
| Trusted machine | several dirs | `Read` | auto-allow reads + edits, forward execute |

No hand-editing for the common cases; the TOML stays the escape hatch and the source of
truth.

### Gap B — L0 says what the machine permits, never whether a human is present

A message at 3am can drive a laptop with nobody watching. `allowed_roots` bounds *where*,
not *when*.

**Proposed:** a `require_presence` knob on execute-class operations — an approver must be
online, or the request defers. Cheap, and it closes the gap between "the machine allows it"
and "someone is accountable for it right now."

---

## 3. Collaboration plane — delegated authority

**This is where the real gap is.**

### The structural finding

A bot acts **as itself**, never on behalf of the person who invoked it. `Principal` is
`{User | Bot} × id` ([`resource/mod.rs:42`](../../server/src/resource/mod.rs)) and the
bridge constructs `Principal::bot(bot_id)`
([`gateway/stream.rs:592`](../../server/src/gateway/stream.rs)). There is **no**
`requested_by` / `on_behalf_of` / `initiated_by` anywhere in the resource layer.

Two consequences:

- **Authority is borrowed, not intersected.** Any member who can mention the bot wields the
  bot's full reach — including reach into channels that member is not in.
- **Scope is bot-wide, not session-wide.** A bot triggered in channel A can call
  `channel.messages` with `channel_id = B` for any B it belongs to. Membership *is* checked
  ([`resource/mod.rs:340`](../../server/src/resource/mod.rs) `NOT_MEMBER`) — but the
  session's own channel is not a fence. `CHEERS_CHANNEL_ID` is an MCP-server *default*, not
  a constraint.

Combine those with untrusted channel text flowing into the agent and you have a
cross-channel read path that no single check is wrong about.

### Proposed, in order of value

1. **Carry the invoker and intersect.** Put `initiated_by` on the task frame
   ([`gateway/dispatcher.rs:83`](../../server/src/gateway/dispatcher.rs)), thread it into
   `Principal`, and evaluate channel reads as `bot ∩ invoker`. Highest-value change on the
   board: it turns "who may mention this bot" from an unbounded question into a bounded
   one, and costs the honest path nothing. Open sub-question: proactive/scheduled sends and
   bot@bot handoffs have no human invoker — they need an explicit "acts as the bot owner"
   principal rather than a silent fallback to today's behavior.
2. **Session-scope by default.** A resource request originating in a session defaults to,
   and unless explicitly granted is confined to, that session's channel. Crossing out
   becomes a grant, not a param.
3. **Treat provenance as accounting, not defense.** The stamping in
   [`domain/context_bundle.rs:93`](../../server/src/domain/context_bundle.rs) ("never trust
   a client-supplied `origin`") and per-target re-authorization in `finalize_bundle_for_target`
   ([`:226`](../../server/src/domain/context_bundle.rs)) are correct and worth keeping — but
   an LLM will not reliably honor a provenance tag. The actual defense against injected
   channel text is that the **capability** is bounded (L0 + approval on execute), which
   already holds.

### What already works here

Do not rebuild these:

- Loop safety: depth cap of 5 **plus** a per-channel dispatch budget that also catches
  proactive-send ping-pong (which resets depth)
  ([`domain/chains.rs:25,92`](../../server/src/domain/chains.rs)).
- Bot→bot dispatch gate, **fail-closed** when its own rule store is unreachable
  ([`domain/bot_event_policy.rs:323`](../../server/src/domain/bot_event_policy.rs)).
- Resource-plane grants with owner-default writes, member-default reads, and **time-boxed
  expiry that stays listed as `expired` rather than vanishing** (migration 0041) — a lapsed
  delegation is visible, never silent. See
  [PLATFORM_RESOURCE_PERMISSION](./PLATFORM_RESOURCE_PERMISSION.md).
- Audit: `channel_operations`, `approval_audit`, `bot_management_audit`.

---

## 4. Four rules that buy convenience without spending security

1. **Prompt budget.** If an approval card reaches a given approver more than ~once a day,
   the *default* is wrong. Raise the default; do not train the click-through. (Once/day is
   a starting number to tune against real data, not a measured threshold.)
2. **Defaults by plane, stated once.** Reads → membership. Channel writes → role. Anything
   touching a person's machine → owner, delegable, expiring. This is already the shape; the
   value is in it being one sentence people can hold in their head.
3. **Visibility instead of blocking.** Audit + activity board + expiring grants are what let
   you stay permissive without being blind.
4. **One page per plane, not per feature.** Three owner pages: *my machines* (hosts + their
   posture), *my delegations* (who may approve what, expiring when), *my sessions* (devices,
   revoke). Governance nobody can find is governance nobody uses.

---

## 5. Deliberate asymmetries — written down so nobody "fixes" them backwards

- **Human INITIATE fails open; dispatch and write gates fail closed.** A human's message
  still posts when the policy store is unreachable
  ([`domain/bot_event_policy.rs:320`](../../server/src/domain/bot_event_policy.rs)),
  whereas bot→bot dispatch, `workspace/read`, `workspace/write` and session-config INITIATE
  ([`api/session_control.rs:280`](../../server/src/api/session_control.rs)) all deny. This
  is defensible — a chat app that stops accepting messages during a DB blip is its own
  outage — but it is a *choice*, not an oversight.
- **Destructive fs ops are gated on the user path, not the bot path.** `fs.rm` / `fs.mv`
  require owner/admin via `dispatch_user`
  ([`resource/mod.rs:262`](../../server/src/resource/mod.rs)); the bot path
  ([`:165`](../../server/src/resource/mod.rs)) has no equivalent gate, on the stated
  reasoning that bots are the primary authors of workspace files. Worth revisiting: it is
  an unbounded delete right sitting behind whatever prompt reaches the agent. A per-bot
  rate cap would preserve the convenience and bound the damage.

## 6. Out of scope for this document

Transport security, device attestation, and E2EE are [SECURITY](./SECURITY.md)'s subject —
including the recorded conflict between group-chat E2EE and server-side reads
(`channel.files.read`, `channel.context`, RAG, search). Nothing proposed here depends on
that decision or moves it.
