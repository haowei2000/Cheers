//! Server-enforced approval for destructive MCP calls
//! (docs/arch/MCP_AUTH_ISOLATION.md §6, M5c).
//!
//! On a human's task (a token with `task` and `obo`), a destructive resource
//! (`fs.rm`, `fs.mv`; the registry's `destructive` set) runs only with an
//! `approval_id` that human approved for exactly that call. Unlike ACP
//! permission cards, the agent cannot skip this: the platform owns these
//! resources, so the platform decides that they need asking.
//!
//! An approval is an ordinary `permission` card (`content_data.kind =
//! "mcp_approval"`), so every client renders it and it resolves through the
//! existing endpoint, which lets only the bound human answer. Its
//! `content_data` holds the binding: task execution, approver, resource and a
//! hash of the exact arguments. Approval is one-time: the gated call consumes
//! it with a compare-and-set, so it can never authorize a second call.

use std::time::Duration;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_state::AppState;
use crate::domain::approval::{self, PendingPermission};

pub const KIND: &str = "mcp_approval";
/// How long `request_approval` waits for the human before giving up.
pub const WAIT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_secs(1);
const OPTION_ALLOW: &str = "allow_once";
const OPTION_REJECT: &str = "reject_once";

/// What one approval is bound to.
pub struct Binding<'a> {
    pub bot_id: Uuid,
    pub channel_id: Uuid,
    pub task: &'a str,
    pub approver: Uuid,
    pub resource: &'a str,
    pub args_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Denied,
    Expired,
}

/// Stable hash of a resource call's params, `approval_id` excluded. serde_json
/// maps are ordered by key, so equal params always hash equally.
pub fn args_hash(params: &Map<String, Value>) -> String {
    let mut params = params.clone();
    params.remove("approval_id");
    hex::encode(Sha256::digest(Value::Object(params).to_string()))
}

/// Posts the approval card and returns its `approval_id`.
pub async fn request(
    state: &AppState,
    binding: &Binding<'_>,
    tool: &str,
    summary: &str,
) -> Result<String, sqlx::Error> {
    let approval_id = Uuid::new_v4().to_string();
    let msg_id = Uuid::new_v4();
    let title = format!("Approve {tool}?");
    let content = format!("{title}\n\n{summary}");
    let content_data = json!({
        "kind": KIND,
        "request_id": approval_id,
        "task": binding.task,
        "approver_user_id": binding.approver.to_string(),
        "resource": binding.resource,
        "args_hash": binding.args_hash,
        "title": title,
        "body": summary,
        "tool": { "kind": "delete", "title": tool },
        "options": [
            { "optionId": OPTION_ALLOW, "name": "Allow once", "kind": "allow_once" },
            { "optionId": OPTION_REJECT, "name": "Reject", "kind": "reject_once" }
        ],
        "resolved": false,
    });
    let mut tx = state.db.begin().await?;
    let channel_seq = crate::domain::channel_seq::allocate(&mut tx, binding.channel_id).await?;
    sqlx::query!(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, content_data, file_ids, channel_seq)
         VALUES ($1, $2, 'bot', $3, $4, 'permission', FALSE, $5::text::jsonb, '[]'::jsonb, $6)",
        msg_id.to_string(),
        binding.channel_id.to_string(),
        binding.bot_id.to_string(),
        &content,
        &content_data.to_string(),
        channel_seq,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Err(error) = approval::record_audit(
        &state.db,
        approval::AuditEvent {
            event_type: "requested",
            bot_id: Some(binding.bot_id),
            channel_id: binding.channel_id,
            request_id: Some(approval_id.clone()),
            msg_id: Some(msg_id),
            detail: Some(json!({ "kind": KIND, "tool": tool, "resource": binding.resource })),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(%error, "mcp approval: audit write failed");
    }
    broadcast(
        state,
        binding.bot_id,
        binding.channel_id,
        msg_id,
        Some(channel_seq),
        &content,
        &content_data,
    )
    .await;
    Ok(approval_id)
}

/// Waits for the human's decision; on timeout the card is finalized as
/// expired, so a late click cannot approve a call the agent gave up on.
pub async fn wait(state: &AppState, approval_id: &str, timeout: Duration) -> Decision {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(Some(card)) = approval::find_pending_by_request_id(&state.db, approval_id).await {
            if let Some(decision) = decided(&card.content_data) {
                return decision;
            }
            if tokio::time::Instant::now() >= deadline {
                let expired = json!({ "resolved": true, "chosen_kind": "expired" });
                return match approval::patch_content_data_if_unresolved(
                    &state.db,
                    card.msg_id,
                    expired,
                )
                .await
                {
                    Ok(true) | Err(_) => Decision::Expired,
                    // Resolved between the read and the expiry: honour it.
                    Ok(false) => approval::find_pending_by_request_id(&state.db, approval_id)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|card| decided(&card.content_data))
                        .unwrap_or(Decision::Expired),
                };
            }
        }
        tokio::time::sleep(POLL).await;
    }
}

fn decided(content_data: &Value) -> Option<Decision> {
    if content_data.get("resolved").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(
        match content_data.get("chosen_kind").and_then(Value::as_str) {
            Some(kind) if kind.starts_with("allow") => Decision::Approved,
            Some("expired") => Decision::Expired,
            _ => Decision::Denied,
        },
    )
}

/// Why a gated call was refused, in words for the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Missing,
    NotApproved,
    Mismatch,
    Used,
}

/// Checks `approval_id` against the call and consumes it once.
pub async fn consume(
    state: &AppState,
    approval_id: Option<&str>,
    binding: &Binding<'_>,
) -> Result<(), Refusal> {
    let approval_id = approval_id.ok_or(Refusal::Missing)?;
    let card = approval::find_pending(&state.db, binding.channel_id, approval_id)
        .await
        .ok()
        .flatten()
        .ok_or(Refusal::Mismatch)?;
    check(&card, binding)?;
    let consumed = sqlx::query!(
        "UPDATE messages
         SET content_data = content_data || jsonb_build_object('consumed_at', NOW())
         WHERE msg_id = $1 AND content_data->>'consumed_at' IS NULL",
        card.msg_id.to_string(),
    )
    .execute(&state.db)
    .await
    .map_err(|error| {
        tracing::error!(%error, "mcp approval: consume failed");
        Refusal::Used
    })?;
    if consumed.rows_affected() == 1 {
        Ok(())
    } else {
        Err(Refusal::Used)
    }
}

/// Pure half of [`consume`]: the card must be an approved `mcp_approval` for
/// this bot, task, human, resource and exact arguments, and not yet used.
fn check(card: &PendingPermission, binding: &Binding<'_>) -> Result<(), Refusal> {
    let data = &card.content_data;
    let field = |name: &str| data.get(name).and_then(Value::as_str);
    let approver = binding.approver.to_string();
    let bound = card.bot_id == binding.bot_id
        && field("kind") == Some(KIND)
        && field("task") == Some(binding.task)
        && field("approver_user_id") == Some(approver.as_str())
        && field("resource") == Some(binding.resource)
        && field("args_hash") == Some(binding.args_hash.as_str());
    if !bound {
        return Err(Refusal::Mismatch);
    }
    if data
        .get("consumed_at")
        .is_some_and(|value| !value.is_null())
    {
        return Err(Refusal::Used);
    }
    match decided(data) {
        Some(Decision::Approved) => Ok(()),
        _ => Err(Refusal::NotApproved),
    }
}

async fn broadcast(
    state: &AppState,
    bot_id: Uuid,
    channel_id: Uuid,
    msg_id: Uuid,
    channel_seq: Option<i64>,
    content: &str,
    content_data: &Value,
) {
    let seers = crate::gateway::ws::agent_bridge::allowed_seers(
        state,
        bot_id,
        channel_id,
        crate::domain::bot_event_policy::EV_PERMISSION_REQUEST,
    )
    .await;
    let wire = crate::gateway::realtime::frame::WireFrame::channel(
        channel_id,
        "message",
        json!({
            "v": crate::infra::db::models::MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id,
            "channel_id": channel_id,
            "channel_seq": channel_seq,
            "sender_type": "bot",
            "sender_id": bot_id,
            "content": content,
            "msg_type": "permission",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
            "content_data": content_data,
        }),
    );
    state
        .fanout
        .broadcast_channel_to_users(channel_id, wire, seers)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(args_hash: &str) -> Binding<'static> {
        Binding {
            bot_id: Uuid::nil(),
            channel_id: Uuid::nil(),
            task: "exec-1",
            approver: Uuid::from_u128(7),
            resource: "fs.rm",
            args_hash: args_hash.into(),
        }
    }

    fn card(extra: Value) -> PendingPermission {
        let mut data = json!({
            "kind": KIND, "request_id": "a-1", "task": "exec-1",
            "approver_user_id": Uuid::from_u128(7).to_string(),
            "resource": "fs.rm", "args_hash": "h", "resolved": true,
            "chosen_kind": "allow_once",
        });
        if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
            data.extend(extra);
        }
        PendingPermission {
            msg_id: Uuid::nil(),
            channel_id: Uuid::nil(),
            bot_id: Uuid::nil(),
            channel_seq: None,
            content: String::new(),
            content_data: data,
        }
    }

    #[test]
    fn args_hash_ignores_the_approval_id_and_key_order() {
        let a: Map<String, Value> =
            serde_json::from_value(json!({"path": "x", "channel_id": "c"})).unwrap();
        let b: Map<String, Value> =
            serde_json::from_value(json!({"approval_id": "a-1", "channel_id": "c", "path": "x"}))
                .unwrap();
        assert_eq!(args_hash(&a), args_hash(&b));
        let c: Map<String, Value> =
            serde_json::from_value(json!({"path": "y", "channel_id": "c"})).unwrap();
        assert_ne!(args_hash(&a), args_hash(&c));
    }

    #[test]
    fn only_an_approved_unused_card_for_this_exact_call_passes() {
        assert_eq!(check(&card(json!({})), &binding("h")), Ok(()));
        assert_eq!(
            check(&card(json!({})), &binding("other-args")),
            Err(Refusal::Mismatch)
        );
        assert_eq!(
            check(&card(json!({"task": "exec-2"})), &binding("h")),
            Err(Refusal::Mismatch)
        );
        assert_eq!(
            check(&card(json!({"chosen_kind": "reject_once"})), &binding("h")),
            Err(Refusal::NotApproved)
        );
        assert_eq!(
            check(&card(json!({"resolved": false})), &binding("h")),
            Err(Refusal::NotApproved)
        );
        assert_eq!(
            check(
                &card(json!({"consumed_at": "2026-10-29T00:00:00Z"})),
                &binding("h")
            ),
            Err(Refusal::Used)
        );
        // An ACP permission card is never an MCP approval.
        assert_eq!(
            check(
                &card(json!({"kind": "agent_bridge_permission_request"})),
                &binding("h")
            ),
            Err(Refusal::Mismatch)
        );
    }
}
