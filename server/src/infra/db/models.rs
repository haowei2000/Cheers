/// DB 表对应的 Rust 结构体。
/// 只做数据载体，不含业务逻辑。
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Message API 对外消息体的统一版本。
pub const MESSAGE_SCHEMA_VERSION: u8 = 1;

// ── User ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    pub email: String,
    pub display_name: Option<String>,
    pub hashed_password: String,
    pub role: String, // "user" | "admin"
    pub avatar_url: Option<String>,
}

// ── Channel ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub channel_type: String, // "public" | "private" | "dm"
    pub workspace_id: Option<String>,
    pub topic: Option<String>,
    pub auto_assist: Option<bool>,
    pub created_at: Option<DateTime<Utc>>,
}

// ── Message ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_type: String, // "user" | "bot" | "system"
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub content: Option<String>,
    pub msg_type: Option<String>,
    pub is_partial: bool,
    pub is_deleted: Option<bool>,
    pub reply_to_msg_id: Option<String>,
    pub file_ids: Vec<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub edited_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageMention {
    pub member_id: String,
    pub member_type: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageFileRef {
    pub file_id: String,
    pub original_filename: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub status: Option<String>,
    pub expires_at: Option<String>,
    pub preview_url: Option<String>,
    pub download_url: Option<String>,
    /// Short derived text for the file when a pipeline produced one — today the
    /// audio transcript snippet (`summary_3lines`); shown under the audio player.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
}

// ── DTO（API 响应用）─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDto {
    /// 消息体 schema version（用于客户端/机器人兼容）。
    pub v: u8,
    pub msg_id: String,
    pub channel_id: String,
    pub channel_seq: Option<i64>,
    pub depth: i32,
    pub sender_type: String,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub content: String,
    pub msg_type: String,
    pub is_partial: bool,
    pub is_deleted: bool,
    pub reply_to_msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub thread_root_msg_id: Option<String>,
    pub file_ids: Vec<String>,
    pub mentions: Vec<MessageMention>,
    pub files: Vec<MessageFileRef>,
    pub created_at: DateTime<Utc>,
    /// Structured payload for system messages (e.g. ACP approval cards). NULL
    /// for plain chat messages.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub content_data: Option<Value>,
    /// Resource-context bundle attached to this message (docs/design/RESOURCE_CONTEXT.md):
    /// refs to Cheers resources the sender picked up. NULL for messages with none.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_bundle: Option<Value>,
    /// Durable agent-step metadata. These fields are populated on list/detail
    /// reads so clients can hide empty disclosure chrome without eagerly
    /// fetching every trace timeline.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace_has_failure: Option<bool>,
}

impl MessageDto {
    pub(crate) fn from_row(row: &crate::infra::db::query_rows::MessageRow) -> Self {
        Self {
            v: MESSAGE_SCHEMA_VERSION,
            msg_id: row.id.clone(),
            channel_id: row.channel_id.clone(),
            channel_seq: row.channel_seq,
            depth: row.depth,
            sender_type: row.sender_type.clone(),
            sender_id: Some(row.sender_id.clone()),
            sender_name: row.sender_name.clone(),
            content: row.content.clone(),
            msg_type: row.msg_type.clone(),
            is_partial: row.is_partial,
            is_deleted: row.is_deleted,
            reply_to_msg_id: row.reply_to_msg_id.clone(),
            thread_root_msg_id: row.thread_root_msg_id.clone(),
            file_ids: serde_json::from_value(
                row.file_ids.clone().unwrap_or(serde_json::Value::Null),
            )
            .unwrap_or_default(),
            mentions: Vec::new(),
            files: Vec::new(),
            created_at: row.created_at,
            content_data: row.content_data.clone(),
            context_bundle: row.context_bundle.clone(),
            trace_count: row.trace_count,
            trace_has_failure: row.trace_has_failure,
        }
    }
}
