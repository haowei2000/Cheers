//! User account management endpoints (admin moderation today; self-service
//! profile + password change land in W16).

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{error::DatabaseError, Row};
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

fn is_admin(claims: &Claims) -> bool {
    matches!(claims.role.as_str(), "system_admin" | "admin")
}

#[derive(Deserialize)]
pub struct ListUsersQuery {
    /// Optional case-insensitive filter over username / display_name / email.
    pub q: Option<String>,
}

/// GET /api/v1/users — admin directory listing (moderation). Optional `?q=` filters
/// by name/username/email. Distinct from `/friends/search` (which is exact-ID-only for
/// non-admins). Newest first, capped.
pub async fn list_users(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(query): Query<ListUsersQuery>,
) -> Result<Json<Vec<Value>>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let term = query.q.unwrap_or_default();
    let term = term.trim();
    let like = if term.is_empty() {
        None
    } else {
        Some(format!("%{term}%"))
    };
    let rows = sqlx::query(
        "SELECT user_id, username, display_name, email, role, avatar_url, is_suspended, created_at
         FROM users
         WHERE is_deleted = FALSE
           AND ($1::text IS NULL OR username ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1)
         ORDER BY created_at DESC
         LIMIT 200",
    )
    .bind(&like)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "user_id": r.try_get::<String, _>("user_id").unwrap_or_default(),
                    "username": r.try_get::<String, _>("username").unwrap_or_default(),
                    "display_name": r.try_get::<Option<String>, _>("display_name").ok().flatten(),
                    "email": r.try_get::<Option<String>, _>("email").ok().flatten(),
                    "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
                    "avatar_url": r.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
                    "is_suspended": r.try_get::<bool, _>("is_suspended").unwrap_or(false),
                    "created_at": r
                        .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                        .map(|t| t.to_rfc3339())
                        .ok(),
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    /// "member" (default) or "admin"; only a system_admin may mint another system_admin.
    #[serde(default)]
    pub role: Option<String>,
}

/// POST /api/v1/users — admin provisions a new user account (the only way to onboard
/// a human until self-service sign-up ships).
pub async fn create_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let username = body.username.trim().to_string();
    if username.is_empty() || username.chars().count() > 64 {
        return Err(AppError::BadRequest(
            "username is required (≤64 chars)".into(),
        ));
    }
    if body.password.chars().count() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    let role = match body.role.as_deref().unwrap_or("member") {
        r @ ("member" | "admin") => r.to_string(),
        "system_admin" if claims.role == "system_admin" => "system_admin".to_string(),
        _ => return Err(AppError::BadRequest("invalid role".into())),
    };
    let email = body
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);
    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let hash = bcrypt::hash(&body.password, bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("hash: {e}")))?;
    let user_id = Uuid::new_v4().to_string();

    let res = sqlx::query(
        "INSERT INTO users (user_id, username, email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&user_id)
    .bind(&username)
    .bind(&email)
    .bind(&hash)
    .bind(&display_name)
    .bind(&role)
    .execute(&state.db)
    .await;
    if let Err(e) = res {
        if e.as_database_error()
            .is_some_and(DatabaseError::is_unique_violation)
        {
            return Err(AppError::Conflict("username or email already taken".into()));
        }
        return Err(AppError::Db(e));
    }
    Ok(Json(
        json!({ "user_id": user_id, "username": username, "role": role }),
    ))
}

/// DELETE /api/v1/users/:user_id — admin soft-deletes a user (frees the username/email,
/// revokes their tokens). Not reversible from the API.
pub async fn delete_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    if user_id == claims.sub {
        return Err(AppError::BadRequest("cannot delete yourself".into()));
    }
    let updated = sqlx::query(
        "UPDATE users
         SET is_deleted = TRUE, deleted_at = NOW(), token_version = token_version + 1
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&user_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "user_id": user_id, "deleted": true })))
}

/// POST /api/v1/users/:user_id/suspend — admin bans a user and revokes every
/// live session by bumping token_version (audit M8 / W6).
pub async fn suspend_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    if user_id == claims.sub {
        return Err(AppError::BadRequest("cannot suspend yourself".into()));
    }
    let updated = sqlx::query(
        "UPDATE users
         SET is_suspended = TRUE, token_version = token_version + 1
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&user_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "user_id": user_id, "suspended": true })))
}

/// POST /api/v1/users/:user_id/unsuspend — admin lifts a ban. Existing tokens
/// stay revoked (token_version was bumped); the user must log in again.
pub async fn unsuspend_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let updated = sqlx::query("UPDATE users SET is_suspended = FALSE WHERE user_id = $1")
        .bind(&user_id)
        .execute(&state.db)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "user_id": user_id, "suspended": false })))
}
