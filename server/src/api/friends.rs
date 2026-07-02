use axum::{
    extract::{Query, State},
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
}

fn pair_key(a: &str, b: &str) -> String {
    if a <= b {
        format!("{a}:{b}")
    } else {
        format!("{b}:{a}")
    }
}

pub async fn search_users(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<FriendQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    // Friends can be added ONLY by exact user ID — no username / display-name search,
    // so the user directory can't be enumerated or browsed. A non-UUID term (or your
    // own id) resolves to nobody; a valid id returns exactly that one user (for a
    // confirm-before-adding card). Email is never matched.
    let raw = q.q.unwrap_or_default();
    let term = raw.trim();
    let Ok(target) = Uuid::parse_str(term) else {
        return Ok(Json(vec![]));
    };
    if target.to_string() == claims.sub {
        return Ok(Json(vec![]));
    }
    let rows = sqlx::query(
        "SELECT user_id, username, display_name, avatar_url
         FROM users
         WHERE user_id = $1 AND is_deleted = FALSE
         LIMIT 1",
    )
    .bind(target.to_string())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "user_id": r.try_get::<String, _>("user_id").unwrap_or_default(),
                    "username": r.try_get::<String, _>("username").unwrap_or_default(),
                    "display_name": r.try_get::<String, _>("display_name").ok(),
                    "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
                })
            })
            .collect(),
    ))
}

pub async fn list_friends(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT f.friendship_id, f.friend_id, f.status, u.username, u.display_name, u.avatar_url
         FROM friendships f
         JOIN users u ON u.user_id = f.friend_id
         WHERE f.user_id = $1 AND f.status = 'accepted'
         ORDER BY u.username",
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
    let exists = sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM users WHERE user_id = $1 AND is_deleted = FALSE) AS ok",
    )
    .bind(&body.friend_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound);
    }
    if is_blocked(&state.db, &claims.sub, &body.friend_id).await? {
        return Err(AppError::Forbidden(
            "cannot send a request to a blocked user".into(),
        ));
    }
    let pair = pair_key(&claims.sub, &body.friend_id);
    // If a relationship row already exists, branch on its state instead of
    // blindly auto-accepting (the old behavior): a pending request the OTHER
    // user already sent me is accepted here (mutual); my own pending request is
    // idempotent; an accepted pair is a no-op.
    if let Some(row) = sqlx::query("SELECT user_id, status FROM friendships WHERE pair_key = $1")
        .bind(&pair)
        .fetch_optional(&state.db)
        .await?
    {
        let status: String = row.try_get("status").unwrap_or_default();
        let requester: String = row.try_get("user_id").unwrap_or_default();
        match status.as_str() {
            "accepted" => {
                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "accepted"}),
                ))
            }
            "pending" if requester == body.friend_id => {
                sqlx::query(
                    "UPDATE friendships SET status='accepted', responded_at=NOW(), updated_at=NOW()
                     WHERE pair_key = $1",
                )
                .bind(&pair)
                .execute(&state.db)
                .await?;
                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "accepted"}),
                ));
            }
            _ => {
                return Ok(Json(
                    json!({"friend_id": body.friend_id, "status": "pending"}),
                ))
            }
        }
    }
    let friendship_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (pair_key) DO NOTHING",
    )
    .bind(&friendship_id)
    .bind(&claims.sub)
    .bind(&body.friend_id)
    .bind(&pair)
    .execute(&state.db)
    .await?;
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
    sqlx::query("DELETE FROM friendships WHERE pair_key = $1")
        .bind(pair_key(&claims.sub, &friend_id))
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"removed": true})))
}

#[derive(Deserialize)]
pub struct RequestsQuery {
    /// "incoming" (default) or "outgoing".
    pub direction: Option<String>,
}

/// GET /api/v1/friends/requests?direction=incoming|outgoing — pending requests.
/// Incoming = others' requests awaiting my response; outgoing = mine awaiting theirs.
pub async fn list_friend_requests(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(rq): Query<RequestsQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let outgoing = rq.direction.as_deref() == Some("outgoing");
    let sql = if outgoing {
        "SELECT f.friendship_id, f.friend_id AS other_id, f.created_at,
                u.username, u.display_name, u.avatar_url
         FROM friendships f JOIN users u ON u.user_id = f.friend_id
         WHERE f.user_id = $1 AND f.status = 'pending'
         ORDER BY f.created_at DESC"
    } else {
        "SELECT f.friendship_id, f.user_id AS other_id, f.created_at,
                u.username, u.display_name, u.avatar_url
         FROM friendships f JOIN users u ON u.user_id = f.user_id
         WHERE f.friend_id = $1 AND f.status = 'pending'
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
                json!({
                    "friendship_id": r.try_get::<String, _>("friendship_id").unwrap_or_default(),
                    "user_id": r.try_get::<String, _>("other_id").unwrap_or_default(),
                    "username": r.try_get::<String, _>("username").unwrap_or_default(),
                    "display_name": r.try_get::<String, _>("display_name").ok(),
                    "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
                    "direction": dir,
                })
            })
            .collect(),
    ))
}

/// POST /api/v1/friends/requests/:user_id/accept — accept an incoming request.
/// Only the target of a pending request may accept it.
pub async fn accept_friend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    axum::extract::Path(user_id): axum::extract::Path<String>,
) -> Result<Json<Value>, AppError> {
    let updated = sqlx::query(
        "UPDATE friendships SET status='accepted', responded_at=NOW(), updated_at=NOW()
         WHERE pair_key = $1 AND user_id = $2 AND friend_id = $3 AND status = 'pending'",
    )
    .bind(pair_key(&claims.sub, &user_id))
    .bind(&user_id)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({"friend_id": user_id, "status": "accepted"})))
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
    sqlx::query("DELETE FROM friendships WHERE pair_key = $1")
        .bind(pair_key(&claims.sub, &body.user_id))
        .execute(&state.db)
        .await?;
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
