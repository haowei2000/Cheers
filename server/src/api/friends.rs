use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

#[derive(Deserialize)]
pub struct FriendQuery {
    pub q: Option<String>,
    pub friend_id: Option<String>,
}

#[derive(Deserialize)]
pub struct FriendRequest {
    pub friend_id: String,
    #[serde(default)]
    pub message: Option<String>,
}

fn pair_key(a: &str, b: &str) -> String {
    if a <= b {
        format!("{a}:{b}")
    } else {
        format!("{b}:{a}")
    }
}

#[cfg(test)]
#[derive(Debug, PartialEq)]
struct FriendLookup<'a> {
    user_id: String,
    username: &'a str,
}

#[cfg(test)]
fn parse_friend_lookup(raw: &str) -> Option<FriendLookup<'_>> {
    let term = raw.trim();
    if term.is_empty() || term.len() > 64 || term.chars().any(char::is_whitespace) {
        return None;
    }
    Some(FriendLookup {
        user_id: Uuid::parse_str(term)
            .ok()
            .map(|id| id.to_string())
            .unwrap_or_default(),
        username: term,
    })
}

pub async fn search_users(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<FriendQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let raw = q.q.unwrap_or_default();
    let term = raw.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    let lookup_id = Uuid::parse_str(term)
        .ok()
        .map(|id| id.to_string())
        .unwrap_or_default();
    let pattern = format!("%{}%", crate::domain::messages::escape_like_pattern(term));
    let rows = sqlx::query(
        "WITH candidates AS (
             SELECT u.user_id,
                    u.username,
                    u.display_name,
                    u.avatar_url,
                    u.bio,
                    FALSE AS is_bot,
                    'public' AS visibility,
                    NULL::text AS created_by
             FROM users u
             WHERE u.is_deleted = FALSE AND u.user_id <> $2
               AND (
                   (u.user_id = $1 AND $1 <> '')
                   OR u.username ILIKE $3
                   OR u.display_name ILIKE $3
               )
             UNION ALL
             SELECT b.bot_id AS user_id,
                    b.username,
                    b.display_name,
                    b.avatar_url,
                    b.description AS bio,
                    TRUE AS is_bot,
                    COALESCE(b.visibility, 'public') AS visibility,
                    b.created_by
             FROM bot_accounts b
             WHERE b.is_disabled = FALSE
               AND (
                   (b.bot_id = $1 AND $1 <> '')
                   OR b.username ILIKE $3
                   OR b.display_name ILIKE $3
               )
         )
         SELECT c.user_id,
                c.username,
                c.display_name,
                c.avatar_url,
                c.bio,
                c.is_bot,
                f.friendship_id,
                f.user_id AS friendship_requester_id,
                f.status AS friendship_status
         FROM candidates c
         LEFT JOIN friendships f
                ON f.pair_key = CASE WHEN c.user_id <= $2 THEN c.user_id || ':' || $2 ELSE $2 || ':' || c.user_id END
         WHERE (
             c.is_bot = FALSE
             OR c.created_by = $2
             OR c.visibility = 'public'
             OR (c.visibility = 'friends' AND f.status = 'accepted')
         )
         ORDER BY
             CASE WHEN c.user_id = $1 AND $1 <> '' THEN 0
                  WHEN LOWER(c.username) = LOWER($4) THEN 1
                  WHEN LOWER(c.username) LIKE LOWER($4) || '%' THEN 2
                  ELSE 3 END,
             c.username
         LIMIT 20",
    )
    .bind(&lookup_id)
    .bind(&claims.sub)
    .bind(&pattern)
    .bind(term)
    .fetch_all(&state.db)
    .await?;

    let items = rows
        .into_iter()
        .map(|r| {
            let user_id: String = r.try_get("user_id").unwrap_or_default();
            let is_bot: bool = r.try_get("is_bot").unwrap_or(false);
            let friendship_status: Option<String> = r.try_get("friendship_status").ok();
            let requester_id: Option<String> = r.try_get("friendship_requester_id").ok();
            let friendship_id: Option<String> = r.try_get("friendship_id").ok();

            let relationship_status = match friendship_status.as_deref() {
                Some("accepted") => "friend",
                Some("pending") => {
                    if requester_id.as_deref() == Some(&claims.sub) {
                        "pending_outgoing"
                    } else {
                        "pending_incoming"
                    }
                }
                _ => "none",
            };

            json!({
                "user_id": user_id,
                "username": r.try_get::<String, _>("username").unwrap_or_default(),
                "display_name": r.try_get::<String, _>("display_name").ok(),
                "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
                "bio": r.try_get::<String, _>("bio").ok(),
                "is_bot": is_bot,
                "relationship_status": relationship_status,
                "friendship_id": friendship_id,
            })
        })
        .collect();

    Ok(Json(items))
}

pub async fn list_friends(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT f.friendship_id,
                CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS friend_id,
                f.status,
                COALESCE(u.username, b.username) AS username,
                COALESCE(u.display_name, b.display_name) AS display_name,
                COALESCE(u.avatar_url, b.avatar_url) AS avatar_url,
                (b.bot_id IS NOT NULL) AS is_bot
         FROM friendships f
         LEFT JOIN users u ON u.user_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
         LEFT JOIN bot_accounts b ON b.bot_id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
         WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
         ORDER BY username",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(|r| json!({
        "friendship_id": r.try_get::<String, _>("friendship_id").unwrap_or_default(),
        "friend_id": r.try_get::<String, _>("friend_id").unwrap_or_default(),
        "status": r.try_get::<String, _>("status").unwrap_or_else(|_| "accepted".into()),
        "username": r.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": r.try_get::<String, _>("display_name").ok(),
        "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
        "is_bot": r.try_get::<bool, _>("is_bot").unwrap_or(false),
    })).collect()))
}

pub async fn add_friend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<FriendRequest>,
) -> Result<Json<Value>, AppError> {
    if body.friend_id == claims.sub {
        return Err(AppError::BadRequest("cannot add yourself".into()));
    }

    let user_row =
        sqlx::query("SELECT user_id FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(&body.friend_id)
            .fetch_optional(&state.db)
            .await?;

    let bot_row = if user_row.is_none() {
        sqlx::query(
            "SELECT bot_id, created_by, COALESCE(friend_policy, 'open') AS friend_policy,
                    COALESCE(visibility, 'public') AS visibility, is_disabled, display_name
             FROM bot_accounts WHERE bot_id = $1",
        )
        .bind(&body.friend_id)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    if user_row.is_none() && bot_row.is_none() {
        return Err(AppError::NotFound);
    }
    if is_blocked(&state.db, &claims.sub, &body.friend_id).await? {
        return Err(AppError::Forbidden(
            "cannot send a request to a blocked user".into(),
        ));
    }
    let message = body
        .message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .map(|mut m| {
            if m.chars().count() > 300 {
                m.truncate(300);
            }
            m
        });

    let pair = pair_key(&claims.sub, &body.friend_id);

    // ── Handle Bot target ────────────────────────────────────────────────────
    if let Some(bot) = bot_row {
        let is_disabled = bot.try_get::<bool, _>("is_disabled").unwrap_or(false);
        if is_disabled {
            return Err(AppError::Forbidden(
                "该 Bot 已被禁用 (This bot is disabled)".into(),
            ));
        }
        let friend_policy = bot
            .try_get::<String, _>("friend_policy")
            .unwrap_or_else(|_| "open".into());

        if friend_policy == "disabled" {
            return Err(AppError::Forbidden(
                "该 Bot 当前不接受好友申请 (This bot does not accept friend requests)".into(),
            ));
        }

        if friend_policy == "open" {
            let friendship_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status, message, responded_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'accepted', $5, NOW(), NOW())
                 ON CONFLICT (pair_key) DO UPDATE
                 SET status = 'accepted', responded_at = NOW(), updated_at = NOW()",
            )
            .bind(&friendship_id)
            .bind(&claims.sub)
            .bind(&body.friend_id)
            .bind(&pair)
            .bind(&message)
            .execute(&state.db)
            .await?;

            let me = Uuid::parse_str(&claims.sub).ok();
            let bot_uuid = Uuid::parse_str(&body.friend_id).ok();
            let channel_id = if let (Some(me), Some(bot_uuid)) = (me, bot_uuid) {
                crate::domain::dms::open_dm(
                    &state.db,
                    crate::domain::dms::Participant::User(me),
                    crate::domain::dms::Participant::Bot(bot_uuid),
                )
                .await
                .ok()
                .map(|opened| opened.channel_id.to_string())
            } else {
                None
            };

            return Ok(Json(json!({
                "friend_id": body.friend_id,
                "status": "accepted",
                "channel_id": channel_id,
                "is_bot": true,
            })));
        }

        // require_approval: insert pending and notify owner
        if let Some(row) =
            sqlx::query("SELECT friendship_id, status FROM friendships WHERE pair_key = $1")
                .bind(&pair)
                .fetch_optional(&state.db)
                .await?
        {
            let status: String = row.try_get("status").unwrap_or_default();
            if status == "accepted" {
                let me = Uuid::parse_str(&claims.sub).ok();
                let bot_uuid = Uuid::parse_str(&body.friend_id).ok();
                let channel_id = if let (Some(me), Some(bot_uuid)) = (me, bot_uuid) {
                    crate::domain::dms::open_dm(
                        &state.db,
                        crate::domain::dms::Participant::User(me),
                        crate::domain::dms::Participant::Bot(bot_uuid),
                    )
                    .await
                    .ok()
                    .map(|opened| opened.channel_id.to_string())
                } else {
                    None
                };
                return Ok(Json(json!({
                    "friend_id": body.friend_id,
                    "status": "accepted",
                    "channel_id": channel_id,
                    "is_bot": true,
                })));
            }
            if message.is_some() {
                let _ = sqlx::query(
                    "UPDATE friendships SET message = $1, updated_at = NOW()
                     WHERE pair_key = $2 AND status = 'pending' AND user_id = $3",
                )
                .bind(&message)
                .bind(&pair)
                .bind(&claims.sub)
                .execute(&state.db)
                .await;
            }
            return Ok(Json(json!({
                "friend_id": body.friend_id,
                "status": "pending",
                "is_bot": true,
            })));
        }

        let friendship_id = Uuid::new_v4().to_string();
        let inserted = sqlx::query(
            "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status, message)
             VALUES ($1, $2, $3, $4, 'pending', $5)
             ON CONFLICT (pair_key) DO NOTHING",
        )
        .bind(&friendship_id)
        .bind(&claims.sub)
        .bind(&body.friend_id)
        .bind(&pair)
        .bind(&message)
        .execute(&state.db)
        .await?
        .rows_affected();

        if inserted > 0 {
            if let Some(owner_id) = bot
                .try_get::<Option<String>, _>("created_by")
                .ok()
                .flatten()
            {
                let _ = crate::api::notifications::deliver_notification_by_id(
                    &state,
                    &owner_id,
                    &format!("friend:{friendship_id}"),
                )
                .await;
            }
        }

        return Ok(Json(json!({
            "friend_id": body.friend_id,
            "status": "pending",
            "is_bot": true,
        })));
    }

    // ── Handle Human target ──────────────────────────────────────────────────
    if let Some(row) = sqlx::query(
        "SELECT friendship_id, user_id, friend_id, status FROM friendships WHERE pair_key = $1",
    )
    .bind(&pair)
    .fetch_optional(&state.db)
    .await?
    {
        let status: String = row.try_get("status").unwrap_or_default();
        let requester: String = row.try_get("user_id").unwrap_or_default();
        let friendship_id: String = row.try_get("friendship_id").unwrap_or_default();
        match status.as_str() {
            "accepted" => {
                let me = Uuid::parse_str(&claims.sub).ok();
                let peer = Uuid::parse_str(&body.friend_id).ok();
                let channel_id = if let (Some(me), Some(peer)) = (me, peer) {
                    crate::domain::dms::open_dm(
                        &state.db,
                        crate::domain::dms::Participant::User(me),
                        crate::domain::dms::Participant::User(peer),
                    )
                    .await
                    .ok()
                    .map(|opened| opened.channel_id.to_string())
                } else {
                    None
                };
                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "accepted", "channel_id": channel_id}),
                ));
            }
            "pending" if requester == body.friend_id => {
                sqlx::query(
                    "UPDATE friendships SET status='accepted', responded_at=NOW(), updated_at=NOW()
                     WHERE pair_key = $1",
                )
                .bind(&pair)
                .execute(&state.db)
                .await?;
                crate::api::notifications::resolve_notification(
                    &state,
                    &claims.sub,
                    &format!("friend:{friendship_id}"),
                )
                .await;

                let me = Uuid::parse_str(&claims.sub).ok();
                let peer = Uuid::parse_str(&body.friend_id).ok();
                let channel_id = if let (Some(me), Some(peer)) = (me, peer) {
                    crate::domain::dms::open_dm(
                        &state.db,
                        crate::domain::dms::Participant::User(me),
                        crate::domain::dms::Participant::User(peer),
                    )
                    .await
                    .ok()
                    .map(|opened| opened.channel_id.to_string())
                } else {
                    None
                };

                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "accepted", "channel_id": channel_id}),
                ));
            }
            _ => {
                if message.is_some() {
                    let _ = sqlx::query(
                        "UPDATE friendships SET message = $1, updated_at = NOW()
                         WHERE pair_key = $2 AND status = 'pending' AND user_id = $3",
                    )
                    .bind(&message)
                    .bind(&pair)
                    .bind(&claims.sub)
                    .execute(&state.db)
                    .await;
                }
                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "pending"}),
                ));
            }
        }
    }
    let friendship_id = Uuid::new_v4().to_string();
    let inserted = sqlx::query(
        "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status, message)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         ON CONFLICT (pair_key) DO NOTHING",
    )
    .bind(&friendship_id)
    .bind(&claims.sub)
    .bind(&body.friend_id)
    .bind(&pair)
    .bind(&message)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted > 0 {
        crate::api::notifications::deliver_notification_by_id(
            &state,
            &body.friend_id,
            &format!("friend:{friendship_id}"),
        )
        .await?;
    }
    Ok(Json(
        json!({"friend_id": body.friend_id, "status": "pending"}),
    ))
}

pub async fn remove_friend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<FriendQuery>,
) -> Result<Json<Value>, AppError> {
    let friend_id = q
        .friend_id
        .ok_or_else(|| AppError::BadRequest("friend_id is required".into()))?;
    let pair = pair_key(&claims.sub, &friend_id);
    let existing = sqlx::query(
        "DELETE FROM friendships
         WHERE pair_key = $1 AND status = 'accepted'
         RETURNING friendship_id, user_id, friend_id",
    )
    .bind(&pair)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(json!({"removed": existing.is_some()})))
}

/// Atomically cancel or decline a pending friend request. The friendship ID
/// identifies the exact request shown to the client; the status and participant
/// predicates ensure a stale action can never remove an accepted friendship.
pub async fn delete_pending_friend_request(
    db: &sqlx::PgPool,
    friendship_id: &str,
    caller_id: &str,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query(
        "DELETE FROM friendships
         WHERE friendship_id = $1
           AND status = 'pending'
           AND (
               user_id = $2
               OR friend_id = $2
               OR friend_id IN (SELECT bot_id FROM bot_accounts WHERE created_by = $2)
           )
         RETURNING user_id, friend_id",
    )
    .bind(friendship_id)
    .bind(caller_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| {
        (
            row.try_get("user_id").unwrap_or_default(),
            row.try_get("friend_id").unwrap_or_default(),
        )
    }))
}

/// DELETE /api/v1/friends/requests/:friendship_id — decline an incoming
/// request or cancel an outgoing request without touching accepted friendships.
pub async fn cancel_friend_request(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(friendship_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let deleted = delete_pending_friend_request(&state.db, &friendship_id, &claims.sub).await?;
    if let Some((requester, target)) = &deleted {
        let notification_id = format!("friend:{friendship_id}");
        crate::api::notifications::resolve_notification(&state, target, &notification_id).await;
        crate::api::notifications::resolve_notification(&state, requester, &notification_id).await;
    }
    Ok(Json(json!({"removed": deleted.is_some()})))
}

#[derive(Deserialize)]
pub struct RequestsQuery {
    /// "incoming" (default) or "outgoing".
    pub direction: Option<String>,
}

/// GET /api/v1/friends/requests?direction=incoming|outgoing — pending requests.
/// Incoming = others' requests awaiting my response (including for bots I own); outgoing = mine awaiting theirs.
pub async fn list_friend_requests(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(rq): Query<RequestsQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let outgoing = rq.direction.as_deref() == Some("outgoing");
    let sql = if outgoing {
        "SELECT f.friendship_id, f.friend_id AS other_id, f.created_at, f.message,
                COALESCE(u.username, b.username) AS username,
                COALESCE(u.display_name, b.display_name) AS display_name,
                COALESCE(u.avatar_url, b.avatar_url) AS avatar_url,
                (b.bot_id IS NOT NULL) AS is_bot,
                NULL::text AS target_bot_id,
                NULL::text AS target_bot_name
         FROM friendships f
         LEFT JOIN users u ON u.user_id = f.friend_id
         LEFT JOIN bot_accounts b ON b.bot_id = f.friend_id
         WHERE f.user_id = $1 AND f.status = 'pending'
         ORDER BY f.created_at DESC"
    } else {
        "SELECT f.friendship_id, f.user_id AS other_id, f.created_at, f.message,
                u.username, u.display_name, u.avatar_url,
                FALSE AS is_bot,
                b.bot_id AS target_bot_id,
                b.display_name AS target_bot_name
         FROM friendships f
         JOIN users u ON u.user_id = f.user_id
         LEFT JOIN bot_accounts b ON b.bot_id = f.friend_id
         WHERE (f.friend_id = $1 OR (b.created_by = $1 AND b.friend_policy = 'require_approval'))
           AND f.status = 'pending'
         ORDER BY f.created_at DESC"
    };
    let rows = sqlx::query(sql)
        .bind(&claims.sub)
        .fetch_all(&state.db)
        .await?;
    let dir = if outgoing { "outgoing" } else { "incoming" };
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let created_at = r
                    .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .ok()
                    .map(|t| t.to_rfc3339());
                let is_bot: bool = r.try_get("is_bot").unwrap_or(false);
                let target_bot_id: Option<String> = r.try_get("target_bot_id").ok().flatten();
                let target_bot_name: Option<String> = r.try_get("target_bot_name").ok().flatten();
                json!({
                    "friendship_id": r.try_get::<String, _>("friendship_id").unwrap_or_default(),
                    "user_id": r.try_get::<String, _>("other_id").unwrap_or_default(),
                    "username": r.try_get::<String, _>("username").unwrap_or_default(),
                    "display_name": r.try_get::<String, _>("display_name").ok(),
                    "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
                    "message": r.try_get::<Option<String>, _>("message").ok().flatten(),
                    "created_at": created_at,
                    "direction": dir,
                    "is_bot": is_bot,
                    "target_bot_id": target_bot_id,
                    "target_bot_name": target_bot_name,
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize, Default)]
pub struct AcceptFriendQuery {
    pub bot_id: Option<String>,
}

/// POST /api/v1/friends/requests/:user_id/accept — accept an incoming request.
/// Only the target of a pending request (or the owner of the target bot) may accept it.
pub async fn accept_friend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
    Query(q): Query<AcceptFriendQuery>,
) -> Result<Json<Value>, AppError> {
    let bot_id = if let Some(bid) = q.bot_id {
        Some(bid)
    } else {
        // Check if there is a pending direct request to claims.sub
        let direct_exists = sqlx::query(
            "SELECT 1 FROM friendships WHERE pair_key = $1 AND user_id = $2 AND friend_id = $3 AND status = 'pending'",
        )
        .bind(pair_key(&claims.sub, &user_id))
        .bind(&user_id)
        .bind(&claims.sub)
        .fetch_optional(&state.db)
        .await?
        .is_some();

        if direct_exists {
            None
        } else {
            // Find bot owned by claims.sub that has a pending request from user_id
            sqlx::query_scalar::<_, String>(
                "SELECT f.friend_id
                 FROM friendships f
                 JOIN bot_accounts b ON b.bot_id = f.friend_id
                 WHERE f.user_id = $1 AND b.created_by = $2 AND f.status = 'pending'
                 LIMIT 1",
            )
            .bind(&user_id)
            .bind(&claims.sub)
            .fetch_optional(&state.db)
            .await?
        }
    };

    if let Some(bid) = bot_id {
        let owns = sqlx::query("SELECT 1 FROM bot_accounts WHERE bot_id = $1 AND created_by = $2")
            .bind(&bid)
            .bind(&claims.sub)
            .fetch_optional(&state.db)
            .await?
            .is_some();
        if !owns && !crate::api::bots::is_admin(&claims) {
            return Err(AppError::Forbidden("not the bot owner".into()));
        }

        let updated = sqlx::query(
            "UPDATE friendships SET status='accepted', responded_at=NOW(), updated_at=NOW()
             WHERE pair_key = $1 AND user_id = $2 AND friend_id = $3 AND status = 'pending'
             RETURNING friendship_id",
        )
        .bind(pair_key(&bid, &user_id))
        .bind(&user_id)
        .bind(&bid)
        .fetch_optional(&state.db)
        .await?;
        let updated = updated.ok_or(AppError::NotFound)?;
        let friendship_id: String = updated.try_get("friendship_id").unwrap_or_default();
        crate::api::notifications::resolve_notification(
            &state,
            &claims.sub,
            &format!("friend:{friendship_id}"),
        )
        .await;

        let user_uuid = Uuid::parse_str(&user_id).ok();
        let bot_uuid = Uuid::parse_str(&bid).ok();
        let channel_id = if let (Some(u), Some(b)) = (user_uuid, bot_uuid) {
            crate::domain::dms::open_dm(
                &state.db,
                crate::domain::dms::Participant::User(u),
                crate::domain::dms::Participant::Bot(b),
            )
            .await
            .ok()
            .map(|opened| opened.channel_id.to_string())
        } else {
            None
        };

        return Ok(Json(
            json!({"friend_id": bid, "user_id": user_id, "status": "accepted", "channel_id": channel_id, "is_bot": true}),
        ));
    }

    let updated = sqlx::query(
        "UPDATE friendships SET status='accepted', responded_at=NOW(), updated_at=NOW()
         WHERE pair_key = $1 AND user_id = $2 AND friend_id = $3 AND status = 'pending'
         RETURNING friendship_id",
    )
    .bind(pair_key(&claims.sub, &user_id))
    .bind(&user_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?;
    let updated = updated.ok_or(AppError::NotFound)?;
    let friendship_id: String = updated.try_get("friendship_id").unwrap_or_default();
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("friend:{friendship_id}"),
    )
    .await;

    // Auto-open DM for newly accepted friends
    let me = Uuid::parse_str(&claims.sub).ok();
    let peer = Uuid::parse_str(&user_id).ok();
    let channel_id = if let (Some(me), Some(peer)) = (me, peer) {
        crate::domain::dms::open_dm(
            &state.db,
            crate::domain::dms::Participant::User(me),
            crate::domain::dms::Participant::User(peer),
        )
        .await
        .ok()
        .map(|opened| opened.channel_id.to_string())
    } else {
        None
    };

    Ok(Json(
        json!({"friend_id": user_id, "status": "accepted", "channel_id": channel_id}),
    ))
}

// ── Blocking (W11) ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BlockRequest {
    pub user_id: String,
}

/// Whether a block exists in either direction between two users. Used to gate
/// friend requests and DMs (a block is mutual in effect).
pub(crate) async fn is_blocked(db: &sqlx::PgPool, a: &str, b: &str) -> Result<bool, AppError> {
    let ok: bool = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM user_blocks
            WHERE (blocker_id = $1 AND blocked_id = $2)
               OR (blocker_id = $2 AND blocked_id = $1)
         ) AS ok",
    )
    .bind(a)
    .bind(b)
    .fetch_one(db)
    .await?
    .try_get("ok")
    .unwrap_or(false);
    Ok(ok)
}

/// POST /api/v1/friends/block — block a user; also drops any existing
/// friendship / pending request between the two.
pub async fn block_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BlockRequest>,
) -> Result<Json<Value>, AppError> {
    if body.user_id == claims.sub {
        return Err(AppError::BadRequest("cannot block yourself".into()));
    }
    let friendship_id: Option<String> =
        sqlx::query_scalar("SELECT friendship_id FROM friendships WHERE pair_key = $1")
            .bind(pair_key(&claims.sub, &body.user_id))
            .fetch_optional(&state.db)
            .await?;
    sqlx::query("DELETE FROM friendships WHERE pair_key = $1")
        .bind(pair_key(&claims.sub, &body.user_id))
        .execute(&state.db)
        .await?;
    if let Some(id) = friendship_id {
        crate::api::notifications::resolve_notification(
            &state,
            &claims.sub,
            &format!("friend:{id}"),
        )
        .await;
        crate::api::notifications::resolve_notification(
            &state,
            &body.user_id,
            &format!("friend:{id}"),
        )
        .await;
    }
    sqlx::query(
        "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING",
    )
    .bind(&claims.sub)
    .bind(&body.user_id)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({"user_id": body.user_id, "blocked": true})))
}

/// POST /api/v1/friends/unblock — lift a block.
pub async fn unblock_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BlockRequest>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2")
        .bind(&claims.sub)
        .bind(&body.user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"user_id": body.user_id, "blocked": false})))
}

/// GET /api/v1/friends/blocks — users the caller has blocked.
pub async fn list_blocks(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT b.blocked_id, u.username, u.display_name, u.avatar_url
         FROM user_blocks b JOIN users u ON u.user_id = b.blocked_id
         WHERE b.blocker_id = $1
         ORDER BY u.username",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "user_id": r.try_get::<String, _>("blocked_id").unwrap_or_default(),
                    "username": r.try_get::<String, _>("username").unwrap_or_default(),
                    "display_name": r.try_get::<String, _>("display_name").ok(),
                    "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
                })
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::parse_friend_lookup;

    #[test]
    fn friend_lookup_accepts_exact_username() {
        let lookup = parse_friend_lookup("ada_lovelace").expect("valid username");
        assert_eq!(lookup.username, "ada_lovelace");
        assert!(lookup.user_id.is_empty());
    }

    #[test]
    fn friend_lookup_normalizes_uuid() {
        let lookup =
            parse_friend_lookup("550E8400-E29B-41D4-A716-446655440000").expect("valid user id");
        assert_eq!(lookup.user_id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn friend_lookup_rejects_broad_or_ambiguous_queries() {
        assert!(parse_friend_lookup("").is_none());
        assert!(parse_friend_lookup("ada lovelace").is_none());
        assert!(parse_friend_lookup(&"a".repeat(65)).is_none());
    }
}
