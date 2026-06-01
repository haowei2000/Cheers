/// DB 表对应的 Rust 结构体。
/// 只做数据载体，不含业务逻辑。
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

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
    pub reply_to_msg_id: Option<String>,
    pub file_ids: Vec<String>,
    pub mentions: Vec<MessageMention>,
    pub files: Vec<MessageFileRef>,
    pub created_at: DateTime<Utc>,
}

impl MessageDto {
    pub fn from_row(row: &sqlx::postgres::PgRow) -> Self {
        use sqlx::Row;
        Self {
            v: MESSAGE_SCHEMA_VERSION,
            msg_id: row.try_get("id").unwrap_or_default(),
            channel_id: row.try_get("channel_id").unwrap_or_default(),
            channel_seq: row.try_get("channel_seq").ok().flatten(),
            depth: row.try_get("depth").unwrap_or(0),
            sender_type: row.try_get("sender_type").unwrap_or_default(),
            sender_id: row.try_get("sender_id").ok(),
            sender_name: row.try_get("sender_name").ok(),
            content: row.try_get("content").unwrap_or_default(),
            msg_type: row
                .try_get("msg_type")
                .unwrap_or_else(|_| "text".to_string()),
            is_partial: row.try_get("is_partial").unwrap_or(false),
            reply_to_msg_id: row.try_get("reply_to_msg_id").ok(),
            file_ids: match row.try_get::<Vec<String>, _>("file_ids") {
                Ok(ids) => ids,
                Err(_) => row
                    .try_get::<Value, _>("file_ids")
                    .ok()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default(),
            },
            mentions: Vec::new(),
            files: Vec::new(),
            created_at: row.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        }
    }
}
