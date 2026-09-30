# Bot reply links and resource cards

Bot replies keep a readable `content` string. Once a reply finishes streaming, the Web client renders it as Markdown with GFM URL detection. A streaming reply remains plain text until its final frame arrives.

## Link targets

| Text in a reply | Destination |
|---|---|
| `https://example.com` or `[label](https://example.com)` | External tab (`http`, `https`, and `mailto` only) |
| `cheers:desk/notes.md#L3`, other valid `cheers:` locator, or `[label](cheers:plan)` | Current channel's resource via `parseLocator` and `openLocator` |
| `` `server/src/main.rs` `` or `[source](server/src/main.rs)` | Existing provenance resolver bound to the reply's Bot and attachments |

Code blocks are never linkified. Unknown schemes, malformed locators, and `cheers:msg/…` remain readable text. Message locators are withheld until the channel and discussion timelines both support a reliable jump. `cheers://channel/…` MCP resource URIs and desktop deep links are distinct from channel-scoped locators.

## Read-only resource cards

`post_message` accepts an optional `cards_json` string containing a JSON array of one to three cards. The Gateway validates the schema and locator before persisting it in `messages.content_data.cards`; `content` remains required as the fallback for older clients and copied/plain text views. Cards render below the reply and use the same in-channel locator route as text links.

For an ACP reply that was already streamed to the timeline, the Bot can call `set_resource_cards(channel_id, msg_id, cards_json)` after completion. It updates only that Bot's own non-empty, finalized reply and broadcasts the new `content_data` to connected clients. Calling it again replaces the cards while preserving other `content_data` fields.

```json
[
  {
    "v": 1,
    "kind": "resource_ref",
    "uri": "cheers:desk/notes.md#L3",
    "title": "Research notes",
    "description": "Findings from this turn"
  }
]
```

`title` and `description` are optional Bot-authored labels, not verified resource metadata. The card performs navigation only; the destination still enforces its normal read authorization and availability checks. The contract rejects extra fields, duplicate URIs, unsupported versions, action-bearing cards, and message locators. This does not add an operation to message text or a new card execution capability.
