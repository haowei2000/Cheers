# Message Content Format: text + flat tokens

> **Status**: Design (v1) · **Decided**: 2026-05-31 · **Language**: English default
>
> The canonical form of `messages.content` is **plain text with a small set of flat,
> self-describing reference tokens** (`<@bot:id>`, `<@user:id>`, `<#file:id>`,
> `<#chan:id>`). Operations never live in message text in any format. Rich/structured
> message bodies use the existing `messages.content_data` JSONB, not the text channel.
>
> Extends [context-and-environment §5.2](./context-and-environment.md) (mentions are a
> first-class `message_mentions` join table) and [DECENTRALIZED_MESH §2](./DECENTRALIZED_MESH.md)
> (only `@`-mentions drive dispatch). This doc fixes the textual *carrier* of those
> mentions so it cannot drift from the table.

---

## 1. Decision

| | Decision |
|---|---|
| Canonical content | **text + flat tokens** (§2). Human-readable prose; deliberate references are tokens. |
| Operations in text | **never** — in any format (raw or XML). Operations are typed `resource_req` (§6). |
| Markup model | **flat, non-nesting tokens only**. No XML/AST. Its weak expressiveness is the point: it *cannot* carry an operation or nest. |
| Rich/structured bodies | the existing `messages.content_data JSONB` (cards, structured messages) — not the text channel. |
| Why now | tokenizing content is a hard-to-reverse format choice (same logic as the mentions table). Greenfield is the cheap moment; retrofitting `@name`→token over message history later is a content migration. |

---

## 2. Token grammar

One uniform rule: `<` *sigil* *kind* `:` *id* `>`.

```
token  := '<' sigil kind ':' id '>'
sigil  := '@'        ; mention  — addressed at a member
        | '#'        ; reference — an inert link
kind   := 'user' | 'bot' | 'file' | 'chan'
id     := VARCHAR(36)            ; [A-Za-z0-9_-]{1,36}
```

Regex: `<([@#])(user|bot|file|chan):([A-Za-z0-9_-]{1,36})>`

| Token | Meaning | Drives dispatch? |
|---|---|---|
| `<@bot:ID>`  | mention a bot member  | **yes** ([DECENTRALIZED_MESH §2](./DECENTRALIZED_MESH.md)) |
| `<@user:ID>` | mention a user member | no — notification only |
| `<#file:ID>` | reference a file       | no — inert link |
| `<#chan:ID>` | reference a channel    | no — inert link |

**Why `@` carries `kind` too** (refining the original `<@id>`): the `#` tokens already
carry a kind, so making `@` uniform keeps one grammar. More importantly it makes content
**self-describing** — parsing content → `message_mentions` rows needs no DB lookup (the
`(id, member_type)` pair is in the token), rendering knows which table to resolve the
name from, and "is this a bot mention?" is answerable from text alone. This is the
polymorphic `(member_id, member_type)` model (the table, `channel_memberships`,
`messages.sender_*`) applied to the token.

**Non-tokens stay literal.** A bare `@name` a human typed without picking an
autocomplete entry is **plain text, not a mention** (no dispatch, no row). `foo@bar.com`
never matches. Malformed `<…>` that does not match the regex stays literal. This makes
mentions *deliberate*; the one exception is bot output (§3).

---

## 3. Two sources, different reliability

Mentions enter the system two ways with opposite trust:

- **Human input → client emits tokens.** The composer has @-autocomplete; when the user
  picks a member/file/channel, the client sends the **token** (`<@bot:ID>`), not a name.
  The server never guesses from free text. Robust by construction.
- **Bot output → name-resolved at write time.** An LLM emits free text `@researcher`; it
  does not know IDs. So bot-authored content gets a **resolution pass at write time**:
  parse bare `@name`, resolve to a channel member, and **rewrite the span to a token** in
  the stored content. Unresolved names stay literal text (no row). This is the *only*
  place the fuzzy name→id parse runs.

> So `domain/mentions.rs::parse` is **not** the primary mention path — it is the
> fallback resolver for bot output (and any legacy un-tokenized input). Token-form
> content from a modern client skips it entirely.

---

## 4. Relationship to `message_mentions`

The token and the table are **complementary, not redundant**:

| | token (in content) | `message_mentions` (table) |
|---|---|---|
| Answers | **where** in the text the mention is | **who** (+ type) was mentioned |
| Used for | inline rendering position | indexed reverse lookup (`@me`), dispatch routing |

**Population (write time):** after content is in token form (client-sent, or rewritten
from bot output), scan the tokens and insert one `message_mentions(msg_id, member_id,
member_type)` row per `<@…>` mention — a pure parse, no lookup, inside the same
transaction as the message INSERT (and the `channel_seq` allocation). `#`-references are
**not** mentions and produce no rows.

**Invariant:** after write, content tokens and `message_mentions` agree. Dispatch reads
the table (or the in-memory parse result); rendering reads the tokens.

---

## 5. Rendering — canonical is neither view

The stored token form is the stable substrate; both views are derived:

- **For humans:** token → current `display_name` (resolved live, so renames never corrupt
  history) rendered as a chip/link by the unified Member component.
- **For bots (push context):** token → readable `@name` text **plus** a structured member
  list (the `channel.members` resource) so the model reads natural language yet can obtain
  IDs when needed. Consistent with "push the index, pull the leaves" and the
  capability/semantic split.

---

## 6. What never goes in content

Operations — `fs.write`, tool calls, member changes, anything that *acts* — are **typed
`resource_req` frames on the data WS**, Grant-gated and audited. They are never parsed out
of message text, in raw or XML form. Putting an operation in text (e.g. `<tool>…</tool>`)
would make a text convention the gate on a capability — exactly what
[context-and-environment §1](./context-and-environment.md) forbids ("a prompt convention
must not be the only gate"). "Files are the blackboard, `@` is the signal"
([DECENTRALIZED_MESH §6](./DECENTRALIZED_MESH.md)): only `@bot` mentions in text drive
control flow; everything else is a typed event.

This is the concrete reason the format is flat tokens, **not** XML — a flat,
non-nesting, fixed-vocabulary token grammar *cannot* express an operation, so it removes
the temptation by construction.

---

## 7. Impact

| Area | Change |
|---|---|
| `domain/mentions.rs` (mesh step 2) | `parse` becomes the **bot-output / legacy fallback** name→token resolver; add a pure token-scan that populates `message_mentions` with no lookup; rewrite bot content spans to tokens before store |
| `create_message` (mesh step 3) | token-scan + `message_mentions` insert happen inside the message transaction, beside `channel_seq` allocation |
| Frontend | composer emits tokens (autocomplete); renderer resolves token→current name; one Member component |
| Rich content | use existing `messages.content_data JSONB`; do not extend the token grammar into a document model |

---

## Open / not in scope

- Additional reference kinds (e.g. `<#msg:id>` to quote a message — reply is already
  structured via `in_reply_to_msg_id`; add only if a real need appears).
- Rich-content schema for `content_data` (cards/forms) — separate effort.
- Markdown handling (code, formatting) is orthogonal: markdown stays markdown; tokens are
  resolved before/after markdown rendering, not nested into it.
