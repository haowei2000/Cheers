use axum::{extract::{Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{app_state::AppState, errors::AppError, transport::middleware::auth::Claims};

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
    if a <= b { format!("{a}:{b}") } else { format!("{b}:{a}") }
}

pub async fn search_users(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<FriendQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    let term = format!("%{}%", q.q.unwrap_or_default());
    let rows = sqlx::query(
        "SELECT user_id, username, display_name, avatar_url
         FROM users
         WHERE user_id != $1 AND is_deleted = FALSE
           AND ($2 = '%%' OR username ILIKE $2 OR display_name ILIKE $2 OR email ILIKE $2)
         ORDER BY username
         LIMIT 20",
    )
    .bind(&claims.sub)
    .bind(term)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(|r| json!({
        "user_id": r.try_get::<String, _>("user_id").unwrap_or_default(),
        "username": r.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": r.try_get::<String, _>("display_name").ok(),
        "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
    })).collect()))
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
    let exists = sqlx::query("SELECT EXISTS(SELECT 1 FROM users WHERE user_id = $1 AND is_deleted = FALSE) AS ok")
        .bind(&body.friend_id)
        .fetch_one(&state.db)
        .await?
        .try_get::<bool, _>("ok")
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound);
    }
    let friendship_id = Uuid::new_v4().to_string();
    let pair = pair_key(&claims.sub, &body.friend_id);
    sqlx::query(
        "INSERT INTO friendships (friendship_id, user_id, friend_id, pair_key, status)
         VALUES ($1, $2, $3, $4, 'accepted')
         ON CONFLICT (pair_key) DO UPDATE SET status = 'accepted', updated_at = NOW()",
    )
    .bind(&friendship_id)
    .bind(&claims.sub)
    .bind(&body.friend_id)
    .bind(pair)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({"friend_id": body.friend_id, "status": "accepted"})))
}

pub async fn remove_friend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<FriendQuery>,
) -> Result<Json<Value>, AppError> {
    let friend_id = q.friend_id.ok_or_else(|| AppError::BadRequest("friend_id is required".into()))?;
    sqlx::query("DELETE FROM friendships WHERE pair_key = $1")
        .bind(pair_key(&claims.sub, &friend_id))
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"removed": true})))
}
