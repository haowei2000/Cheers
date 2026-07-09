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

use crate::{
    api::middleware::Claims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};

fn is_admin(claims: &Claims) -> bool {
    matches!(claims.role.as_str(), "system_admin" | "admin")
}

/// A profile-patch field: distinguishes "absent" (leave column unchanged) from
/// "present" (set it, an empty string clearing to NULL). We read the raw JSON
/// object rather than a struct so an omitted key and an explicit `null` differ.
struct PatchField {
    provided: bool,
    value: Option<String>,
}

impl PatchField {
    /// Trim, and treat empty as NULL so clearing a field is "send an empty string".
    fn read(obj: &serde_json::Map<String, Value>, key: &str) -> Self {
        match obj.get(key) {
            Some(v) => PatchField {
                provided: true,
                value: v
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            },
            None => PatchField {
                provided: false,
                value: None,
            },
        }
    }
}

/// GET /api/v1/users/me — the authenticated user's own profile, including the
/// self-service status line + bio ("information"). The login response only carries
/// id/name/role, so the client fetches this to hydrate the rest.
pub async fn get_me(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let r = sqlx::query(
        "SELECT user_id, username, display_name, email, role, avatar_url, bio,
                status_text, status_emoji, status_updated_at
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!({
        "user_id": r.try_get::<String, _>("user_id").unwrap_or_default(),
        "username": r.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": r.try_get::<Option<String>, _>("display_name").ok().flatten(),
        "email": r.try_get::<Option<String>, _>("email").ok().flatten(),
        "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
        "avatar_url": r.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
        "bio": r.try_get::<Option<String>, _>("bio").ok().flatten(),
        "status_text": r.try_get::<Option<String>, _>("status_text").ok().flatten(),
        "status_emoji": r.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
        "status_updated_at": r
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at")
            .ok()
            .flatten()
            .map(|t| t.to_rfc3339()),
    })))
}

/// PATCH /api/v1/users/me — self-service profile edit. Every field is optional;
/// an omitted key is left unchanged, an explicit empty string clears it to NULL.
/// `status_updated_at` is refreshed whenever the status line/emoji is touched.
pub async fn update_me(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("request body must be a JSON object".into()))?;
    let display_name = PatchField::read(obj, "display_name");
    let bio = PatchField::read(obj, "bio");
    let avatar_url = PatchField::read(obj, "avatar_url");
    let status_text = PatchField::read(obj, "status_text");
    let status_emoji = PatchField::read(obj, "status_emoji");

    // Length guards: reject early with a clean 400 instead of overflowing a column
    // (display_name is VARCHAR(255) → a 500) or fanning an unbounded field out to every
    // channel member via the member_updated broadcast below (bio is TEXT).
    if display_name
        .value
        .as_deref()
        .is_some_and(|s| s.chars().count() > 255)
    {
        return Err(AppError::BadRequest(
            "display_name too long (≤255 chars)".into(),
        ));
    }
    if bio.value.as_deref().is_some_and(|s| s.chars().count() > 4000) {
        return Err(AppError::BadRequest("bio too long (≤4000 chars)".into()));
    }
    if status_text
        .value
        .as_deref()
        .is_some_and(|s| s.chars().count() > 140)
    {
        return Err(AppError::BadRequest(
            "status_text too long (≤140 chars)".into(),
        ));
    }
    if status_emoji
        .value
        .as_deref()
        .is_some_and(|s| s.chars().count() > 32)
    {
        return Err(AppError::BadRequest("status_emoji too long".into()));
    }

    let touched_status = status_text.provided || status_emoji.provided;

    sqlx::query(
        "UPDATE users SET
            display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
            bio          = CASE WHEN $4 THEN $5 ELSE bio END,
            avatar_url   = CASE WHEN $6 THEN $7 ELSE avatar_url END,
            status_text  = CASE WHEN $8 THEN $9 ELSE status_text END,
            status_emoji = CASE WHEN $10 THEN $11 ELSE status_emoji END,
            status_updated_at = CASE WHEN $12 THEN NOW() ELSE status_updated_at END
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .bind(display_name.provided)
    .bind(&display_name.value)
    .bind(bio.provided)
    .bind(&bio.value)
    .bind(avatar_url.provided)
    .bind(&avatar_url.value)
    .bind(status_text.provided)
    .bind(&status_text.value)
    .bind(status_emoji.provided)
    .bind(&status_emoji.value)
    .bind(touched_status)
    .execute(&state.db)
    .await?;

    // Push the fresh profile to every channel this user is in so open clients update
    // the member's card live (no channel-switch/reload needed). Only when something
    // card-visible actually changed; best-effort (never fails the edit).
    if display_name.provided
        || bio.provided
        || avatar_url.provided
        || status_text.provided
        || status_emoji.provided
    {
        broadcast_member_update(&state, &claims.sub).await;
    }

    get_me(State(state), Extension(claims)).await
}

/// Broadcast a user's current profile (name/avatar/bio/status) to every channel they
/// belong to, as a `member_updated` frame, so browsers viewing those channels refresh
/// the member's hovercard in place. Bots don't need this — their `channel.members`
/// resource is a live DB read, so they always see the latest on their next read.
///
/// Best-effort: any DB or send hiccup is swallowed (the profile edit already
/// succeeded; a missed live update self-heals on the next member-list fetch).
pub async fn broadcast_member_update(state: &AppState, user_id: &str) {
    let row = match sqlx::query(
        "SELECT display_name, avatar_url, bio, status_text, status_emoji, status_updated_at
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        _ => return,
    };
    let profile = json!({
        "member_id": user_id,
        "member_type": "user",
        "display_name": row.try_get::<Option<String>, _>("display_name").ok().flatten(),
        "avatar_url": row.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
        "bio": row.try_get::<Option<String>, _>("bio").ok().flatten(),
        "status_text": row.try_get::<Option<String>, _>("status_text").ok().flatten(),
        "status_emoji": row.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
        // RFC3339 so a user's member card / hovercard can render "updated x ago"
        // live — the same field the bot broadcast emits (audit item 5).
        "status_updated_at": row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at")
            .ok()
            .flatten()
            .map(|t| t.to_rfc3339()),
    });

    let channels: Vec<String> = sqlx::query_scalar(
        "SELECT channel_id::text FROM channel_memberships
         WHERE member_id = $1 AND member_type = 'user'",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for cid in channels {
        let Ok(channel_uuid) = Uuid::parse_str(&cid) else {
            continue;
        };
        let mut data = profile.clone();
        data["channel_id"] = json!(cid);
        let frame = WireFrame::channel(channel_uuid, "member_updated", data);
        state.fanout.broadcast_channel(channel_uuid, frame).await;
    }
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
    // Revocation must reach live sockets too, not just future HTTP requests.
    if let Ok(uid) = user_id.parse::<Uuid>() {
        state.fanout.kick_user(uid);
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
    // A ban takes effect NOW: tear down the user's live WS sessions (mirrors the
    // bot kill-switch, which kicks the connector on disable).
    if let Ok(uid) = user_id.parse::<Uuid>() {
        state.fanout.kick_user(uid);
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
