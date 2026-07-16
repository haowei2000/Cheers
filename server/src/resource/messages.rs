use chrono::Utc;
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{channel_seq, mentions, messages as domain_messages},
    infra::db::models::{MessageDto, MessageFileRef, MessageMention, MESSAGE_SCHEMA_VERSION},
};

use super::{authorize_channel_read, authorize_channel_write, Principal, ResourceResult};

pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .clamp(1, 200);

    if let Some(since_seq) = params.get("since_seq").and_then(|v| v.as_i64()) {
        let page =
            domain_messages::list_channel_messages_since_seq(db, &channel_id, since_seq, limit)
                .await
                .map_err(super::db_err("messages.read: list since_seq"))?;
        return message_page_response(channel_id, page, limit);
    }

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
    .map_err(super::db_err("messages.read: list channel messages page"))?;
    message_page_response(channel_id, page, limit)
}

pub async fn handle_by_seq(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    let min_seq = params
        .get("min_seq")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "min_seq required"))?;
    let max_seq = params.get("max_seq").and_then(|v| v.as_i64());
    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .clamp(1, 200);
    let page =
        domain_messages::list_channel_messages_by_seq(db, &channel_id, min_seq, max_seq, limit)
            .await
            .map_err(super::db_err("messages.by_seq: list by seq range"))?;

    message_page_response(channel_id, page, limit)
}

pub async fn handle_search(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    let query = params
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "query required"))?;
    let before = params
        .get("before")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(20)
        .clamp(1, 200);

    let page = domain_messages::search_channel_messages(db, &channel_id, query, before, limit)
        .await
        .map_err(super::db_err("messages.search: search channel messages"))?;
    message_page_response(channel_id, page, limit)
}

fn message_page_response(
    channel_id: Uuid,
    page: domain_messages::MessageListPage,
    limit: i64,
) -> ResourceResult {
    let has_more = page.has_more;
    let messages: Vec<Value> = page
        .messages
        .into_iter()
        .map(|message| {
            serde_json::to_value(message).unwrap_or_else(|_| fallback_message_value(channel_id))
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

fn fallback_message_value(channel_id: Uuid) -> Value {
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
}

pub async fn handle_create(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    // Perf instrumentation: total time spent in the DB-only create handler (authz +
    // mention resolution + tx). Broadcast/bot-trigger happen at the WS boundary and
    // are timed separately in agent_bridge — see docs on the post_message hot path.
    let started = std::time::Instant::now();
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_write(db, principal, channel_id).await?;

    let msg_id = Uuid::new_v4();
    let content = params
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
    // Resource-context bundle attached by the posting bot (docs/design/RESOURCE_CONTEXT.md,
    // "Bot / Manual pick"). Untrusted input: normalize to read verbs only, cap size, and
    // stamp origin="bot" (reads stay consumer-governed at pull time). NULL when absent/empty.
    let context_bundle = params
        .get("context_bundle")
        .and_then(crate::domain::context_bundle::sanitize_bot_bundle);
    // mention_names：LLM agent 传 username/display_name，gateway 做 name→UUID 解析
    let mention_names: Vec<String> = params
        .get("mention_names")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // mention_ids：程序化调用直接传 UUID
    let mention_ids: Vec<Uuid> = params
        .get("mention_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().and_then(|s| s.parse().ok()))
                .collect()
        })
        .unwrap_or_default();
    let now = Utc::now();
    // 先解析 names，再验证 IDs，合并去重
    let mut mentions = mentions::resolve_mention_names(db, channel_id, &mention_names)
        .await
        .map_err(resource_mention_error)?;
    let id_mentions = mentions::validate_mention_ids(db, channel_id, &mention_ids)
        .await
        .map_err(resource_mention_error)?;
    for m in id_mentions {
        if !mentions
            .iter()
            .any(|x| x.member_id == m.member_id && x.member_type == m.member_type)
        {
            mentions.push(m);
        }
    }

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("messages.create: begin tx"))?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(super::db_err("messages.create: allocate channel_seq"))?;
    sqlx::query(
        "INSERT INTO messages
         (msg_id, channel_id, sender_type, sender_id, content, msg_type,
          is_partial, is_deleted, in_reply_to_msg_id, file_ids, created_at, channel_seq,
          context_bundle)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, $7, $8, $9, $10, $11)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(principal.sender_type())
    .bind(principal.principal_id.to_string())
    .bind(&content)
    .bind(&msg_type)
    .bind(&reply_to_msg_id)
    .bind(&serde_json::json!(file_ids.clone()))
    .bind(now)
    .bind(channel_seq)
    .bind(context_bundle.clone())
    .execute(&mut *tx)
    .await
    .map_err(super::db_err("messages.create: insert message"))?;
    mentions::insert_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(super::db_err("messages.create: insert mentions"))?;
    tx.commit()
        .await
        .map_err(super::db_err("messages.create: commit tx"))?;

    let files = load_message_file_refs(db, &file_ids)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let files_len = files.len();

    let mention_dtos = mention_dtos(&mentions);
    let dto = MessageDto {
        v: MESSAGE_SCHEMA_VERSION,
        msg_id: msg_id.to_string(),
        channel_id: channel_id.to_string(),
        channel_seq: Some(channel_seq),
        depth: 0,
        sender_type: principal.sender_type().into(),
        sender_id: Some(principal.principal_id.to_string()),
        sender_name: None,
        content,
        msg_type,
        is_partial: false,
        reply_to_msg_id,
        file_ids,
        mentions: mention_dtos,
        files,
        created_at: now,
        content_data: None,
        context_bundle,
    };

    tracing::debug!(
        %channel_id,
        %msg_id,
        mentions = mentions.len(),
        files = files_len,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "messages.create db-path complete"
    );

    Ok(serde_json::to_value(dto).unwrap_or_else(|_| {
        serde_json::json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id.to_string(),
            "channel_id": channel_id.to_string(),
            "channel_seq": channel_seq,
            "sender_type": principal.sender_type(),
            "sender_id": principal.principal_id.to_string(),
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
        mentions::MentionParseError::InvalidMember { member_id } => super::resource_error(
            "MEMBER_NOT_FOUND",
            format!("mention target not in channel: {member_id}"),
        ),
        mentions::MentionParseError::NameNotFound { name } => super::resource_error(
            "MEMBER_NOT_FOUND",
            format!("mention name not found in channel: {name}"),
        ),
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
        "SELECT file_id, original_filename, content_type, size_bytes, status, expires_at,
                summary_3lines
         FROM file_records
         WHERE file_id = ANY($1)",
    )
    .bind(file_ids)
    .fetch_all(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, ctx = "load_message_file_refs: select file records", "resource internal error");
    })?;

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
            summary: row
                .try_get::<Option<String>, _>("summary_3lines")
                .ok()
                .flatten(),
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
                summary: None,
            });
        }
    }

    Ok(ordered)
}
