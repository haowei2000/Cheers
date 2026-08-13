//! REST handlers and response models for discussion-mode channel threads.
//!
//! Discussion lists are ordered by the latest activity on each root message and
//! use opaque cursors. Detail requests page replies backwards while always
//! returning the thread root. Every handler verifies both channel membership and
//! that the channel is configured for discussion mode before reading messages.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::messages::{hydrate_message_rows, MESSAGE_LIST_SELECT},
    errors::AppError,
    infra::db::models::MessageDto,
};

const DEFAULT_LIMIT: i64 = 30;

#[derive(Debug, Deserialize)]
pub struct ListDiscussionsQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub q: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DiscussionDetailQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DiscussionCursor {
    at: DateTime<Utc>,
    id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscussionReplyPreview {
    pub msg_id: String,
    pub sender_id: String,
    pub sender_type: String,
    pub sender_name: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscussionParticipant {
    pub member_id: String,
    pub member_type: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiscussionSummary {
    pub root: MessageDto,
    pub reply_count: i64,
    pub last_activity_at: DateTime<Utc>,
    pub last_reply: Option<DiscussionReplyPreview>,
    pub participants: Vec<DiscussionParticipant>,
    pub participant_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ListDiscussionsResponse {
    pub discussions: Vec<DiscussionSummary>,
    pub meta: DiscussionListMeta,
}

#[derive(Debug, Serialize)]
pub struct DiscussionListMeta {
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct DiscussionDetailResponse {
    pub root: MessageDto,
    pub replies: Vec<MessageDto>,
    pub meta: DiscussionDetailMeta,
}

#[derive(Debug, Serialize)]
pub struct DiscussionDetailMeta {
    pub has_more_before: bool,
    pub limit: i64,
}

/// Decode an opaque discussion-list cursor supplied by an API client.
fn decode_cursor(raw: Option<&str>) -> Result<Option<DiscussionCursor>, AppError> {
    let Some(raw) = raw else { return Ok(None) };
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::BadRequest("invalid discussion cursor".into()))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| AppError::BadRequest("invalid discussion cursor".into()))
}

/// Serialize a discussion-list cursor for the next page of results.
fn encode_cursor(cursor: &DiscussionCursor) -> Option<String> {
    serde_json::to_vec(cursor)
        .ok()
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}

/// Require a user to belong to a channel whose conversation mode is `discuss`.
async fn ensure_discuss_member(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<(), AppError> {
    let row = sqlx::query(
        "SELECT c.conversation_mode,
                EXISTS(
                    SELECT 1 FROM channel_memberships cm
                    WHERE cm.channel_id = c.channel_id
                      AND cm.member_id = $2
                      AND cm.member_type = 'user'
                ) AS is_member
         FROM channels c
         WHERE c.channel_id = $1",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&state.db)
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound);
    };
    if !row.try_get::<bool, _>("is_member").unwrap_or(false) {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    if row
        .try_get::<String, _>("conversation_mode")
        .unwrap_or_else(|_| "chat".into())
        != "discuss"
    {
        return Err(AppError::BadRequest(
            "channel is not in discuss mode".into(),
        ));
    }
    Ok(())
}

/// List discussion roots in descending order of their most recent activity.
///
/// Implements `GET /api/v1/channels/:channel_id/discussions`, including optional
/// text search and cursor pagination.
pub async fn list_discussions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(query): Query<ListDiscussionsQuery>,
) -> Result<Json<ListDiscussionsResponse>, AppError> {
    let user_id = claims
        .sub
        .parse::<Uuid>()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    ensure_discuss_member(&state, channel_id, user_id).await?;

    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 100);
    let cursor = decode_cursor(query.cursor.as_deref())?;
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(100).collect::<String>());
    let cursor_at = cursor.as_ref().map(|value| value.at);
    let cursor_id = cursor.as_ref().map(|value| value.id.clone());

    let rows = sqlx::query(
        "WITH topic_stats AS (
            SELECT root.msg_id AS root_id,
                   GREATEST(
                       root.created_at,
                       COALESCE(MAX(reply.created_at), root.created_at)
                   ) AS last_activity_at,
                   COUNT(reply.msg_id) FILTER (
                       WHERE reply.is_deleted = FALSE
                         AND reply.msg_type NOT IN ('permission', 'auth_required')
                   )::bigint AS reply_count
            FROM messages root
            LEFT JOIN messages reply
              ON reply.channel_id = root.channel_id
             AND reply.thread_root_msg_id = root.msg_id
             AND reply.is_partial = FALSE
             AND reply.is_secret = FALSE
             AND reply.is_deleted = FALSE
             AND reply.msg_type NOT IN ('permission', 'auth_required')
            WHERE root.channel_id = $1
              AND root.thread_root_msg_id IS NULL
              AND root.is_partial = FALSE
              AND root.is_secret = FALSE
              AND root.sender_type IN ('user', 'bot')
              AND root.msg_type NOT IN ('permission', 'auth_required')
              AND (
                  $2::text IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM messages hit
                      WHERE hit.channel_id = root.channel_id
                        AND COALESCE(hit.thread_root_msg_id, hit.msg_id) = root.msg_id
                        AND hit.is_partial = FALSE
                        AND hit.is_secret = FALSE
                        AND hit.is_deleted = FALSE
                        AND hit.msg_type NOT IN ('permission', 'auth_required')
                        AND hit.content ILIKE '%' || $2 || '%'
                  )
              )
            GROUP BY root.msg_id, root.created_at
         )
         SELECT root_id, last_activity_at, reply_count
         FROM topic_stats
         WHERE ($3::timestamptz IS NULL)
            OR (last_activity_at, root_id) < ($3, $4)
         ORDER BY last_activity_at DESC, root_id DESC
         LIMIT $5",
    )
    .bind(channel_id.to_string())
    .bind(search)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;

    let has_more = rows.len() > limit as usize;
    let page_rows = rows.iter().take(limit as usize).collect::<Vec<_>>();
    let root_ids = page_rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("root_id").ok())
        .collect::<Vec<_>>();

    if root_ids.is_empty() {
        return Ok(Json(ListDiscussionsResponse {
            discussions: Vec::new(),
            meta: DiscussionListMeta {
                next_cursor: None,
                has_more: false,
            },
        }));
    }

    let root_rows = sqlx::query(&format!("{MESSAGE_LIST_SELECT} WHERE m.msg_id = ANY($1)"))
        .bind(&root_ids)
        .fetch_all(&state.db)
        .await?;
    let roots = hydrate_message_rows(&state.db, &root_rows).await?;
    let roots_by_id = roots
        .into_iter()
        .map(|message| (message.msg_id.clone(), message))
        .collect::<HashMap<_, _>>();

    let preview_rows = sqlx::query(
        "SELECT DISTINCT ON (m.thread_root_msg_id)
                m.thread_root_msg_id AS root_id, m.msg_id, m.sender_id,
                m.sender_type,
                COALESCE(NULLIF(u.display_name, ''), u.username,
                         NULLIF(b.display_name, ''), b.username, m.sender_id) AS sender_name,
                m.content, m.created_at
         FROM messages m
         LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
         LEFT JOIN bot_accounts b ON m.sender_type = 'bot' AND b.bot_id = m.sender_id
         WHERE m.channel_id = $1
           AND m.thread_root_msg_id = ANY($2)
           AND m.is_partial = FALSE
           AND m.is_secret = FALSE
           AND m.is_deleted = FALSE
           AND m.msg_type NOT IN ('permission', 'auth_required')
         ORDER BY m.thread_root_msg_id, m.channel_seq DESC NULLS LAST, m.created_at DESC",
    )
    .bind(channel_id.to_string())
    .bind(&root_ids)
    .fetch_all(&state.db)
    .await?;
    let previews = preview_rows
        .into_iter()
        .filter_map(|row| {
            let root_id = row.try_get::<String, _>("root_id").ok()?;
            Some((
                root_id,
                DiscussionReplyPreview {
                    msg_id: row.try_get("msg_id").ok()?,
                    sender_id: row.try_get("sender_id").ok()?,
                    sender_type: row.try_get("sender_type").ok()?,
                    sender_name: row.try_get("sender_name").ok()?,
                    content: row.try_get("content").unwrap_or_default(),
                    created_at: row.try_get("created_at").ok()?,
                },
            ))
        })
        .collect::<HashMap<_, _>>();

    let participant_rows = sqlx::query(
        "WITH ranked AS (
            SELECT COALESCE(m.thread_root_msg_id, m.msg_id) AS root_id,
                   m.sender_id, m.sender_type,
                   COALESCE(NULLIF(u.display_name, ''), u.username,
                            NULLIF(b.display_name, ''), b.username, m.sender_id) AS name,
                   COALESCE(u.avatar_url, b.avatar_url) AS avatar_url,
                   MAX(m.created_at) AS last_seen
            FROM messages m
            LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
            LEFT JOIN bot_accounts b ON m.sender_type = 'bot' AND b.bot_id = m.sender_id
            WHERE m.channel_id = $1
              AND COALESCE(m.thread_root_msg_id, m.msg_id) = ANY($2)
              AND m.is_partial = FALSE
              AND m.is_secret = FALSE
              AND m.is_deleted = FALSE
              AND m.msg_type NOT IN ('permission', 'auth_required')
              AND m.sender_type IN ('user', 'bot')
            GROUP BY COALESCE(m.thread_root_msg_id, m.msg_id), m.sender_id,
                     m.sender_type, u.display_name, u.username, b.display_name,
                     b.username, u.avatar_url, b.avatar_url
         )
         SELECT root_id, sender_id, sender_type, name, avatar_url, last_seen,
                COUNT(*) OVER (PARTITION BY root_id)::bigint AS participant_count
         FROM ranked
         ORDER BY root_id, last_seen DESC",
    )
    .bind(channel_id.to_string())
    .bind(&root_ids)
    .fetch_all(&state.db)
    .await?;
    let mut participants: HashMap<String, (Vec<DiscussionParticipant>, i64)> = HashMap::new();
    for row in participant_rows {
        let root_id: String = row.try_get("root_id")?;
        let entry = participants.entry(root_id).or_insert_with(|| {
            (
                Vec::new(),
                row.try_get::<i64, _>("participant_count").unwrap_or(0),
            )
        });
        if entry.0.len() < 3 {
            entry.0.push(DiscussionParticipant {
                member_id: row.try_get("sender_id")?,
                member_type: row.try_get("sender_type")?,
                name: row.try_get("name")?,
                avatar_url: row.try_get("avatar_url").ok(),
            });
        }
    }

    let mut discussions = Vec::with_capacity(root_ids.len());
    for row in &page_rows {
        let root_id: String = row.try_get("root_id")?;
        let Some(root) = roots_by_id.get(&root_id).cloned() else {
            continue;
        };
        let (participant_list, participant_count) = participants
            .remove(&root_id)
            .unwrap_or_else(|| (Vec::new(), 0));
        discussions.push(DiscussionSummary {
            root,
            reply_count: row.try_get("reply_count").unwrap_or(0),
            last_activity_at: row.try_get("last_activity_at")?,
            last_reply: previews.get(&root_id).cloned(),
            participants: participant_list,
            participant_count,
        });
    }

    let next_cursor = if has_more {
        page_rows.last().and_then(|row| {
            encode_cursor(&DiscussionCursor {
                at: row.try_get("last_activity_at").ok()?,
                id: row.try_get("root_id").ok()?,
            })
        })
    } else {
        None
    };

    Ok(Json(ListDiscussionsResponse {
        discussions,
        meta: DiscussionListMeta {
            next_cursor,
            has_more,
        },
    }))
}

/// Return a discussion root and one backwards-paginated window of replies.
///
/// Implements `GET /api/v1/channels/:channel_id/discussions/:root_msg_id`.
pub async fn get_discussion(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, root_msg_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<DiscussionDetailQuery>,
) -> Result<Json<DiscussionDetailResponse>, AppError> {
    let user_id = claims
        .sub
        .parse::<Uuid>()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    ensure_discuss_member(&state, channel_id, user_id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);

    let root_rows = sqlx::query(&format!(
        "{MESSAGE_LIST_SELECT}
         WHERE m.channel_id = $1
           AND m.msg_id = $2
           AND m.thread_root_msg_id IS NULL
           AND m.is_partial = FALSE
           AND m.is_secret = FALSE
           AND m.sender_type IN ('user', 'bot')
           AND m.msg_type NOT IN ('permission', 'auth_required')"
    ))
    .bind(channel_id.to_string())
    .bind(root_msg_id.to_string())
    .fetch_all(&state.db)
    .await?;
    let mut roots = hydrate_message_rows(&state.db, &root_rows).await?;
    let root = roots.pop().ok_or(AppError::NotFound)?;

    let before_seq = if let Some(before) = query.before.as_deref() {
        sqlx::query_scalar::<_, i64>(
            "SELECT channel_seq FROM messages
             WHERE msg_id = $1 AND channel_id = $2 AND thread_root_msg_id = $3",
        )
        .bind(before)
        .bind(channel_id.to_string())
        .bind(root_msg_id.to_string())
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    let mut reply_rows = sqlx::query(&format!(
        "{MESSAGE_LIST_SELECT}
         WHERE m.channel_id = $1
           AND m.thread_root_msg_id = $2
           AND m.is_partial = FALSE
           AND m.is_secret = FALSE
           AND m.is_deleted = FALSE
           AND m.msg_type NOT IN ('permission', 'auth_required')
           AND ($3::bigint IS NULL OR m.channel_seq < $3)
         ORDER BY m.channel_seq DESC NULLS LAST, m.created_at DESC
         LIMIT $4"
    ))
    .bind(channel_id.to_string())
    .bind(root_msg_id.to_string())
    .bind(before_seq)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more_before = reply_rows.len() > limit as usize;
    if has_more_before {
        reply_rows.truncate(limit as usize);
    }
    let mut replies = hydrate_message_rows(&state.db, &reply_rows).await?;
    replies.reverse();

    Ok(Json(DiscussionDetailResponse {
        root,
        replies,
        meta: DiscussionDetailMeta {
            has_more_before,
            limit,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discussion_cursor_round_trips_activity_and_stable_id() {
        let cursor = DiscussionCursor {
            at: "2026-08-09T08:30:00Z".parse().unwrap(),
            id: "00000000-0000-0000-0000-000000000071".into(),
        };
        let encoded = encode_cursor(&cursor).expect("cursor encodes");
        let decoded = decode_cursor(Some(&encoded))
            .expect("cursor decodes")
            .expect("cursor exists");
        assert_eq!(decoded.at, cursor.at);
        assert_eq!(decoded.id, cursor.id);
    }

    #[test]
    fn malformed_discussion_cursor_is_rejected() {
        assert!(decode_cursor(Some("not-base64!")).is_err());
    }
}
