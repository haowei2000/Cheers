use chrono::Utc;
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{channel_seq, mentions, messages as domain_messages},
    infra::db::models::{MessageDto, MessageFileRef, MessageMention, MESSAGE_SCHEMA_VERSION},
};

use super::{check_bot_in_channel, check_write_permission, ResourceResult};

pub async fn handle_read(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let before = params
        .get("before")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let before_id = params
        .get("before_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let around_id = params
        .get("around_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let after = params
        .get("after")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let after_id = params
        .get("after_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let resolved_before = before.or(before_id).or(around_id);
    let resolved_after = after.or(after_id);
    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .min(200);

    if resolved_before.is_some() && resolved_after.is_some() {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "set either before or after, not both",
        ));
    }

    let page = domain_messages::list_channel_messages(
        db,
        &channel_id,
        resolved_before,
        resolved_after,
        limit,
    )
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let has_more = page.has_more;
    let messages = page.messages;

    let messages: Vec<Value> = messages
        .into_iter()
        .map(|message| {
            serde_json::to_value(message).unwrap_or_else(|_| {
                serde_json::json!({
                    "v": MESSAGE_SCHEMA_VERSION,
                    "msg_id": "",
                    "channel_id": channel_id.to_string(),
                    "channel_seq": null,
                    "sender_type": "system",
                    "content": "",
                    "msg_type": "text",
                    "is_partial": false,
                    "reply_to_msg_id": null,
                    "file_ids": [],
                    "mentions": [],
                    "files": [],
                    "created_at": Utc::now(),
                })
            })
        })
        .collect();

    Ok(serde_json::json!({
        "messages": &messages,
        "data": &messages,
        "meta": {
            "has_more_before": page.has_more_before,
            "has_more_after": page.has_more_after,
            "has_more": has_more,
            "anchor_found": page.anchor_found,
            "limit": limit,
        },
    }))
}

pub async fn handle_create(
    db: &PgPool,
    bot_id: Uuid,
    params: &Value,
    session_id: Option<&str>,
) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_write_permission(
        db,
        bot_id,
        channel_id,
        "channel:messages",
        "create",
        session_id,
    )
    .await?;

    let msg_id = Uuid::new_v4();
    let raw_content = params
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let msg_type = params
        .get("msg_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text")
        .to_string();
    let reply_to_msg_id = params
        .get("reply_to_msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
        .map(|v| v.to_string());
    let file_ids = parse_file_ids(params.get("file_ids"));
    let now = Utc::now();
    let normalized = mentions::normalize_bot_content(db, channel_id, &raw_content)
        .await
        .map_err(resource_mention_error)?;

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    sqlx::query(
        "INSERT INTO messages
         (msg_id, channel_id, sender_type, sender_id, content, msg_type,
          is_partial, is_deleted, in_reply_to_msg_id, file_ids, created_at, channel_seq)
         VALUES ($1, $2, 'bot', $3, $4, $5, FALSE, FALSE, $6, $7, $8, $9)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(&normalized.content)
    .bind(&msg_type)
    .bind(&reply_to_msg_id)
    .bind(&serde_json::json!(file_ids.clone()))
    .bind(now)
    .bind(channel_seq)
    .execute(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    mentions::insert_batch(&mut tx, msg_id, &normalized.mentions)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let files = load_message_file_refs(db, &file_ids)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let mention_dtos = mention_dtos(&normalized.mentions);
    let dto = MessageDto {
        v: MESSAGE_SCHEMA_VERSION,
        msg_id: msg_id.to_string(),
        channel_id: channel_id.to_string(),
        channel_seq: Some(channel_seq),
        sender_type: "bot".into(),
        sender_id: Some(bot_id.to_string()),
        sender_name: None,
        content: normalized.content,
        msg_type,
        is_partial: false,
        reply_to_msg_id,
        file_ids,
        mentions: mention_dtos,
        files,
        created_at: now,
    };

    Ok(serde_json::to_value(dto).unwrap_or_else(|_| {
        serde_json::json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id.to_string(),
            "channel_id": channel_id.to_string(),
            "channel_seq": channel_seq,
            "sender_type": "bot",
            "sender_id": bot_id.to_string(),
            "content": "",
            "msg_type": "text",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
            "created_at": now,
        })
    }))
}

fn resource_mention_error(error: mentions::MentionParseError) -> (String, String) {
    match error {
        mentions::MentionParseError::Db(_) => super::resource_error("INTERNAL_ERROR", "db error"),
        other => super::resource_error("INVALID_PARAMS", &other.to_string()),
    }
}

fn mention_dtos(mentions: &[mentions::Mention]) -> Vec<MessageMention> {
    mentions
        .iter()
        .map(|mention| MessageMention {
            member_id: mention.member_id.to_string(),
            member_type: mention.member_type.as_str().to_string(),
            username: None,
            display_name: None,
        })
        .collect()
}

fn parse_file_ids(value: Option<&Value>) -> Vec<String> {
    let mut file_ids = Vec::new();
    for v in value
        .and_then(|v| v.as_array())
        .map_or(&[][..], Vec::as_slice)
        .iter()
    {
        let Some(raw) = v.as_str() else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !file_ids.iter().any(|item| item == trimmed) {
            file_ids.push(trimmed.to_string());
        }
    }
    file_ids
}

async fn load_message_file_refs(
    db: &PgPool,
    file_ids: &[String],
) -> Result<Vec<MessageFileRef>, ()> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }

    let rows = sqlx::query(
        "SELECT file_id, original_filename, content_type, size_bytes, status, expires_at
         FROM file_records
         WHERE file_id = ANY($1)",
    )
    .bind(file_ids)
    .fetch_all(db)
    .await
    .map_err(|_| ())?;

    let mut refs = Vec::new();
    for row in rows {
        let file_id = row.try_get::<String, _>("file_id").unwrap_or_default();
        let size_bytes = row.try_get::<Option<i64>, _>("size_bytes").ok().flatten();
        refs.push(MessageFileRef {
            file_id: file_id.clone(),
            original_filename: row
                .try_get::<Option<String>, _>("original_filename")
                .ok()
                .flatten(),
            content_type: row
                .try_get::<Option<String>, _>("content_type")
                .ok()
                .flatten(),
            size_bytes,
            status: row.try_get::<Option<String>, _>("status").ok().flatten(),
            expires_at: row
                .try_get::<Option<chrono::DateTime<Utc>>, _>("expires_at")
                .ok()
                .flatten()
                .map(|at| at.to_rfc3339()),
            preview_url: Some(format!("/api/v1/files/{}/preview", file_id)),
            download_url: Some(format!("/api/v1/files/{}/download", file_id)),
        });
    }

    let mut ordered = Vec::new();
    for file_id in file_ids {
        if let Some(item) = refs.iter().find(|item| item.file_id == *file_id) {
            ordered.push(item.clone());
        } else {
            ordered.push(MessageFileRef {
                file_id: file_id.clone(),
                original_filename: None,
                content_type: None,
                size_bytes: None,
                status: Some("missing".into()),
                expires_at: None,
                preview_url: Some(format!("/api/v1/files/{}/preview", file_id)),
                download_url: Some(format!("/api/v1/files/{}/download", file_id)),
            });
        }
    }

    Ok(ordered)
}
