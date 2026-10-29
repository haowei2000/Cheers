//! Images the agent emits in its reply, delivered as channel attachments.
//!
//! ACP carries agent-produced media as `image` content blocks — in an
//! `agent_message_chunk`, or inside a `tool_call` / `tool_call_update`'s
//! `content` list (e.g. an image-generation tool's result). The text stream
//! drops them, so the run collects them here and uploads them with the Done
//! frame. This stays ACP-generic: only the standard content-block shape and the
//! standard tool `kind` are read.
//!
//! A tool result is not always something the agent made: `read` / `fetch` /
//! `execute` / … return content the agent looked at (a local screenshot, a file
//! it opened). Only tools of kind `other` (ACP's default, and what image
//! generation reports) are treated as producing reply media.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use super::*;
use crate::config::FileUploadPolicy;

/// Upper bound on images attached to a single reply.
pub(super) const MAX_IMAGES_PER_RUN: usize = 8;

/// Strings above this size in a forwarded `acp_event` payload are replaced by a
/// placeholder. The event log is for classification, not a media store.
const MAX_EVENT_STRING_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct AgentImage {
    /// Content hash: dedups repeats within a run and keys the upload's idempotency.
    pub key: u64,
    pub data_b64: String,
    pub mime_type: String,
    pub filename: String,
}

/// Whether a tool of this ACP `kind` produces media rather than surfacing
/// existing content. An absent kind is ACP's default, `other`.
pub(super) fn tool_kind_produces_media(tool_kind: Option<&str>) -> bool {
    matches!(tool_kind, None | Some("other"))
}

/// Image content blocks carried by one `session/update`. `tool_kind` is the
/// tool call's `kind`, which a `tool_call_update` delta usually omits, so the
/// caller resolves it from the call's snapshot.
pub(super) fn images_in_update(
    kind: &str,
    update: &Value,
    tool_kind: Option<&str>,
) -> Vec<AgentImage> {
    let blocks: Vec<&Value> = match kind {
        "agent_message_chunk" => update.get("content").into_iter().collect(),
        "tool_call" | "tool_call_update" if tool_kind_produces_media(tool_kind) => update
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("content"))
                    .filter_map(|item| item.get("content"))
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    blocks.into_iter().filter_map(image_block).collect()
}

fn image_block(block: &Value) -> Option<AgentImage> {
    if block.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let data_b64 = block.get("data").and_then(Value::as_str)?.trim();
    if data_b64.is_empty() {
        return None;
    }
    let mime_type = block
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|mime| mime.starts_with("image/"))
        .unwrap_or("image/png")
        .to_string();
    let mut hasher = DefaultHasher::new();
    data_b64.hash(&mut hasher);
    let key = hasher.finish();
    let filename = block
        .get("uri")
        .and_then(Value::as_str)
        .and_then(|uri| uri.rsplit(['/', '\\']).next())
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("image-{:08x}.{}", key as u32, extension(&mime_type)));
    Some(AgentImage {
        key,
        data_b64: data_b64.to_string(),
        mime_type,
        filename,
    })
}

fn extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// Whether local policy lets this image leave the machine, and the gateway
/// would accept it. `gateway_max_bytes` is the limit the gateway advertises;
/// checking it here keeps an image it would reject from crossing the socket.
pub(super) fn image_allowed(
    policy: &FileUploadPolicy,
    gateway_max_bytes: Option<u64>,
    image: &AgentImage,
) -> bool {
    if !policy.agent_output {
        return false;
    }
    // base64 → bytes, without decoding the payload just to measure it.
    let approx_bytes = (image.data_b64.len() as u64 / 4) * 3;
    let max_bytes = gateway_max_bytes.map_or(policy.max_bytes, |max| max.min(policy.max_bytes));
    if approx_bytes > max_bytes {
        return false;
    }
    policy.allowed_content_types.is_empty()
        || policy
            .allowed_content_types
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&image.mime_type))
}

/// Replace oversized inline media in a forwarded event payload: an `image` /
/// `audio` block's `data`, a resource `blob`, or any other large string that is
/// pure base64 (e.g. a tool's `rawOutput` echoing the image). Text — diffs, tool
/// output, prose — always has whitespace or punctuation and is left intact, so
/// the trace inspector still sees the full content.
pub(super) fn redact_inline_media(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(redact_inline_media),
        Value::Object(map) => {
            let media_block = matches!(
                map.get("type").and_then(Value::as_str),
                Some("image" | "audio")
            );
            for (key, field) in map.iter_mut() {
                let media_field = (media_block && key == "data") || key == "blob";
                match field {
                    Value::String(text) if media_field || looks_like_base64(text) => {
                        omit_if_large(text)
                    }
                    _ => redact_inline_media(field),
                }
            }
        }
        Value::String(text) if looks_like_base64(text) => omit_if_large(text),
        _ => {}
    }
}

fn looks_like_base64(text: &str) -> bool {
    text.len() > MAX_EVENT_STRING_BYTES
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

fn omit_if_large(text: &mut String) {
    if text.len() > MAX_EVENT_STRING_BYTES {
        *text = format!("[omitted {} bytes]", text.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(agent_output: bool) -> FileUploadPolicy {
        FileUploadPolicy {
            allow: false,
            agent_output,
            max_bytes: 1024,
            allowed_content_types: Vec::new(),
        }
    }

    fn generation_update() -> Value {
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "ig_1",
            "status": "completed",
            "content": [
                { "type": "content", "content": { "type": "text", "text": "Revised prompt: cat" } },
                { "type": "content", "content": {
                    "type": "image", "data": "aGVsbG8=", "mimeType": "image/png",
                    "uri": "/Users/me/.codex/generated_images/s/exec-1.png"
                } }
            ]
        })
    }

    #[test]
    fn finds_image_in_generation_tool_call_update_content() {
        let images = images_in_update("tool_call_update", &generation_update(), Some("other"));
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].filename, "exec-1.png");
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].data_b64, "aGVsbG8=");
        // A delta whose call never declared a kind is ACP's default, `other`.
        assert_eq!(
            images_in_update("tool_call_update", &generation_update(), None).len(),
            1
        );
    }

    #[test]
    fn ignores_images_from_tools_that_surface_existing_content() {
        for kind in [
            "read", "search", "fetch", "execute", "edit", "delete", "move", "think",
        ] {
            assert!(
                images_in_update("tool_call_update", &generation_update(), Some(kind)).is_empty(),
                "{kind} tool image must not be delivered"
            );
        }
    }

    #[test]
    fn finds_image_in_message_chunk_and_names_it_without_uri() {
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "image", "data": "aGVsbG8=", "mimeType": "image/jpeg" }
        });
        // The chunk is the agent's own reply; a stale tool kind must not gate it.
        let images = images_in_update("agent_message_chunk", &update, Some("read"));
        assert_eq!(images.len(), 1);
        assert!(images[0].filename.starts_with("image-"));
        assert!(images[0].filename.ends_with(".jpg"));
    }

    #[test]
    fn ignores_text_and_other_updates() {
        let chunk = json!({ "content": { "type": "text", "text": "hi" } });
        assert!(images_in_update("agent_message_chunk", &chunk, None).is_empty());
        let plan = json!({ "content": [{ "type": "content", "content": { "type": "image", "data": "aGVsbG8=" } }] });
        assert!(images_in_update("plan", &plan, None).is_empty());
    }

    #[test]
    fn same_data_has_same_key() {
        let a = json!({ "content": { "type": "image", "data": "aGVsbG8=" } });
        let b = json!({ "content": [{ "type": "content", "content": { "type": "image", "data": "aGVsbG8=" } }] });
        assert_eq!(
            images_in_update("agent_message_chunk", &a, None)[0].key,
            images_in_update("tool_call_update", &b, None)[0].key
        );
    }

    #[test]
    fn policy_gates_agent_output_size_and_type() {
        let image = AgentImage {
            key: 1,
            data_b64: "aGVsbG8=".into(),
            mime_type: "image/png".into(),
            filename: "a.png".into(),
        };
        assert!(image_allowed(&policy(true), None, &image));
        assert!(!image_allowed(&policy(false), None, &image));

        let mut small = policy(true);
        small.max_bytes = 2;
        assert!(!image_allowed(&small, None, &image));

        let mut typed = policy(true);
        typed.allowed_content_types = vec!["image/jpeg".into()];
        assert!(!image_allowed(&typed, None, &image));
        typed.allowed_content_types.push("IMAGE/PNG".into());
        assert!(image_allowed(&typed, None, &image));
    }

    #[test]
    fn gateway_limit_tightens_but_never_loosens_local_policy() {
        let image = AgentImage {
            key: 1,
            data_b64: "aGVsbG8=".into(), // ~6 bytes
            mime_type: "image/png".into(),
            filename: "a.png".into(),
        };
        assert!(!image_allowed(&policy(true), Some(2), &image));
        assert!(image_allowed(&policy(true), Some(1 << 30), &image));
        let mut small = policy(true);
        small.max_bytes = 2;
        assert!(!image_allowed(&small, Some(1 << 30), &image));
    }

    #[test]
    fn redacts_inline_media_but_keeps_large_text() {
        let big_b64 = "A".repeat(MAX_EVENT_STRING_BYTES + 1);
        let big_text = "fn main() {}\n".repeat(MAX_EVENT_STRING_BYTES / 8);
        let mut payload = json!({
            "title": "Image generation",
            "content": [
                { "type": "content", "content": { "type": "image", "data": big_b64 } },
                { "type": "diff", "path": "a.rs", "oldText": big_text, "newText": "x" }
            ],
            "rawOutput": { "result": big_b64, "status": "completed" },
            "resource": { "blob": "small" }
        });
        redact_inline_media(&mut payload);
        assert_eq!(payload["title"], "Image generation");
        assert_eq!(payload["rawOutput"]["status"], "completed");
        assert_eq!(
            payload["content"][0]["content"]["data"],
            format!("[omitted {} bytes]", MAX_EVENT_STRING_BYTES + 1)
        );
        assert!(payload["rawOutput"]["result"]
            .as_str()
            .unwrap()
            .starts_with("[omitted"));
        assert_eq!(payload["content"][1]["oldText"], big_text);
        assert_eq!(payload["resource"]["blob"], "small");
    }
}
