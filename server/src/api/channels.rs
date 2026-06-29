use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

#[derive(Serialize)]
pub struct ChannelDto {
    pub channel_id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub purpose: Option<String>,
    pub auto_assist: bool,
    pub allow_member_invites: bool,
    pub allow_bot_adds: bool,
    /// Messages newer than the caller's `last_read_at` not sent by the caller.
    /// 0 for queries that don't compute it (create/get/update single-channel).
    #[serde(default)]
    pub unread_count: i64,
}

#[derive(Deserialize)]
pub struct ChannelCreateRequest {
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    pub purpose: Option<String>,
    pub allow_member_invites: Option<bool>,
    pub allow_bot_adds: Option<bool>,
    #[serde(default)]
    pub initial_user_ids: Vec<String>,
    #[serde(default)]
    pub initial_bot_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct ChannelUpdateRequest {
    pub name: Option<String>,
    pub purpose: Option<String>,
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    pub auto_assist: Option<bool>,
    pub allow_member_invites: Option<bool>,
    pub allow_bot_adds: Option<bool>,
}

#[derive(Deserialize)]
pub struct AddMemberRequest {
    pub member_id: String,
    pub member_type: String,
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct MemberRoleRequest {
    pub role: String,
}

#[derive(Deserialize)]
pub struct DmCreateRequest {
    pub target_user_id: Option<String>,
    pub target_bot_id: Option<String>,
}

fn dto(row: sqlx::postgres::PgRow) -> ChannelDto {
    ChannelDto {
        channel_id: row.try_get("channel_id").unwrap_or_default(),
        workspace_id: row.try_get("workspace_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        channel_type: row.try_get("type").unwrap_or_else(|_| "public".to_string()),
        purpose: row.try_get("purpose").ok(),
        auto_assist: row.try_get("auto_assist").unwrap_or(false),
        allow_member_invites: row.try_get("allow_member_invites").unwrap_or(true),
        allow_bot_adds: row.try_get("allow_bot_adds").unwrap_or(true),
        unread_count: row.try_get("unread_count").unwrap_or(0),
    }
}

async fn is_channel_member(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
    role: &str,
) -> Result<bool, AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(true);
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    Ok(ok)
}

async fn ensure_channel_admin(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
    role: &str,
) -> Result<(), AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(());
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user' AND role IN ('owner', 'admin')
        ) AS ok",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("channel admin required".into()))
    }
}

#[derive(Deserialize)]
pub struct ListChannelsQuery {
    pub workspace_id: Option<String>,
}

pub async fn list_channels(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<ListChannelsQuery>,
) -> Result<Json<Vec<ChannelDto>>, AppError> {
    // Scope to one workspace when `?workspace_id=` is given (the sidebar always
    // passes it). The handler previously ignored the param entirely, leaking
    // every workspace's channels into whichever one you had selected.
    let rows = sqlx::query(
        "SELECT DISTINCT c.channel_id, c.workspace_id, c.name, c.type, c.purpose,
                c.auto_assist, c.allow_member_invites, c.allow_bot_adds, c.created_at,
                COALESCE((
                    SELECT count(*) FROM messages m
                    WHERE m.channel_id = c.channel_id
                      AND m.is_partial = FALSE
                      AND m.sender_id <> $1
                      AND m.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
                ), 0) AS unread_count
         FROM channels c
         LEFT JOIN channel_memberships cm ON cm.channel_id = c.channel_id AND cm.member_id = $1
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $1
         WHERE c.type != 'dm'
           AND (cm.member_id IS NOT NULL OR wm.user_id IS NOT NULL OR $2 IN ('system_admin', 'admin'))
           AND ($3::text IS NULL OR c.workspace_id = $3)
         ORDER BY c.created_at DESC",
    )
    .bind(&claims.sub)
    .bind(&claims.role)
    .bind(&q.workspace_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(dto).collect()))
}

/// Whether two users may open a DM: they're accepted friends or already share a
/// channel (audit/W7 — blocks cold-DM-to-strangers spam). Bot DMs aren't gated.
async fn users_can_dm(db: &sqlx::PgPool, a: &str, b: &str) -> Result<bool, AppError> {
    // A block in either direction overrides everything — no DM.
    if crate::api::friends::is_blocked(db, a, b).await? {
        return Ok(false);
    }
    let ok: bool = sqlx::query(
        "SELECT (
            EXISTS(SELECT 1 FROM friendships
                   WHERE status = 'accepted'
                     AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)))
            OR EXISTS(SELECT 1 FROM channel_memberships ma
                      JOIN channel_memberships mb ON ma.channel_id = mb.channel_id
                      WHERE ma.member_type = 'user' AND mb.member_type = 'user'
                        AND ma.member_id = $1 AND mb.member_id = $2)
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

/// POST /api/v1/channels/dm — find-or-create the DM with one target (user OR bot). A DM is
/// a type='dm' channel (see CONVERSATION_MODEL.md); the dedup/create lives in domain::dms.
pub async fn create_dm(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<DmCreateRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    let me = Uuid::parse_str(&claims.sub).map_err(|_| AppError::BadRequest("bad user id".into()))?;
    let (target_id, is_bot) = match (body.target_user_id, body.target_bot_id) {
        (Some(u), None) => (u, false),
        (None, Some(b)) => (b, true),
        _ => {
            return Err(AppError::BadRequest(
                "exactly one of target_user_id / target_bot_id".into(),
            ))
        }
    };
    if !is_bot && !users_can_dm(&state.db, &claims.sub, &target_id.to_string()).await? {
        return Err(AppError::Forbidden(
            "you can only DM friends or people you share a channel with".into(),
        ));
    }
    let channel_id = crate::domain::dms::find_or_create_dm(&state.db, me, &target_id, is_bot).await?;
    let row = sqlx::query(
        "SELECT channel_id, workspace_id, name, type, purpose, auto_assist,
                allow_member_invites, allow_bot_adds
         FROM channels WHERE channel_id = $1",
    )
    .bind(channel_id.to_string())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(dto(row)))
}

/// GET /api/v1/channels/dm — the caller's DMs (type='dm' channels they're a member of).
/// Access is membership-driven (independent of the anchor workspace). Each row carries
/// `peer_name` (the OTHER participant) so the client can label the nameless DM channel.
pub async fn list_dms(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT c.channel_id, c.workspace_id, c.name, c.type, c.purpose, c.auto_assist,
                c.allow_member_invites, c.allow_bot_adds,
                COALESCE((
                    SELECT count(*) FROM messages msg
                    WHERE msg.channel_id = c.channel_id
                      AND msg.is_partial = FALSE
                      AND msg.sender_id <> $1
                      AND msg.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
                ), 0) AS unread_count,
                COALESCE(
                  (SELECT COALESCE(u.display_name, u.username) FROM channel_memberships m
                     JOIN users u ON u.user_id = m.member_id
                     WHERE m.channel_id = c.channel_id AND m.member_type = 'user'
                       AND m.member_id <> $1 LIMIT 1),
                  (SELECT COALESCE(b.display_name, b.username) FROM channel_memberships m
                     JOIN bot_accounts b ON b.bot_id = m.member_id
                     WHERE m.channel_id = c.channel_id AND m.member_type = 'bot' LIMIT 1),
                  'Direct Message'
                ) AS peer_name
         FROM channels c
         JOIN channel_memberships cm
           ON cm.channel_id = c.channel_id AND cm.member_id = $1 AND cm.member_type = 'user'
         WHERE c.type = 'dm'
         ORDER BY c.created_at DESC",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let peer: String = r.try_get("peer_name").unwrap_or_default();
                let mut v = serde_json::to_value(dto(r)).unwrap_or_else(|_| json!({}));
                if let Value::Object(ref mut m) = v {
                    m.insert("peer_name".into(), json!(peer));
                }
                v
            })
            .collect(),
    ))
}

pub async fn create_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<ChannelCreateRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let allowed = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2
        ) AS ok",
    )
    .bind(&body.workspace_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if !allowed && !matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Err(AppError::Forbidden("workspace member required".into()));
    }
    let channel_id = Uuid::new_v4().to_string();
    let channel_type = body.channel_type.unwrap_or_else(|| "public".into());
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "INSERT INTO channels
            (channel_id, workspace_id, name, type, purpose, allow_member_invites, allow_bot_adds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(&body.workspace_id)
    .bind(body.name.trim())
    .bind(&channel_type)
    .bind(&body.purpose)
    .bind(body.allow_member_invites.unwrap_or(true))
    .bind(body.allow_bot_adds.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'user', 'owner', $2) ON CONFLICT DO NOTHING")
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;
    for user_id in body.initial_user_ids {
        sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'user', 'member', $3) ON CONFLICT DO NOTHING")
            .bind(&channel_id)
            .bind(user_id)
            .bind(&claims.sub)
            .execute(&mut *tx)
            .await?;
    }
    for bot_id in body.initial_bot_ids {
        sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'bot', 'member', $3) ON CONFLICT DO NOTHING")
            .bind(&channel_id)
            .bind(bot_id)
            .bind(&claims.sub)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(dto(row)))
}

pub async fn get_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<ChannelDto>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    let row = sqlx::query("SELECT channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(dto(row)))
}

pub async fn update_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<ChannelUpdateRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let row = sqlx::query(
        "UPDATE channels
         SET name = COALESCE($2, name),
             purpose = COALESCE($3, purpose),
             type = COALESCE($4, type),
             auto_assist = COALESCE($5, auto_assist),
             allow_member_invites = COALESCE($6, allow_member_invites),
             allow_bot_adds = COALESCE($7, allow_bot_adds)
         WHERE channel_id = $1
         RETURNING channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(body.name)
    .bind(body.purpose)
    .bind(body.channel_type)
    .bind(body.auto_assist)
    .bind(body.allow_member_invites)
    .bind(body.allow_bot_adds)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(dto(row)))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    sqlx::query("DELETE FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"deleted": true})))
}

pub async fn list_channel_members(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<Value>>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    let rows = sqlx::query(
        "SELECT cm.member_id, cm.member_type, cm.role,
                COALESCE(u.username, b.username) AS username,
                COALESCE(u.display_name, b.display_name) AS display_name
         FROM channel_memberships cm
         LEFT JOIN users u ON cm.member_type = 'user' AND u.user_id = cm.member_id
         LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.bot_id = cm.member_id
         WHERE cm.channel_id = $1
         ORDER BY cm.member_type, username",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
                    "member_type": r.try_get::<String, _>("member_type").unwrap_or_default(),
                    "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
                    "username": r.try_get::<String, _>("username").ok(),
                    "display_name": r.try_get::<String, _>("display_name").ok(),
                })
            })
            .collect(),
    ))
}

pub async fn add_channel_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<AddMemberRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if !matches!(body.member_type.as_str(), "user" | "bot") {
        return Err(AppError::BadRequest(
            "member_type must be user or bot".into(),
        ));
    }
    let role = body.role.unwrap_or_else(|| "member".into());
    if !matches!(role.as_str(), "owner" | "admin" | "member" | "readonly") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, member, or readonly".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, member_id) DO UPDATE SET
            member_type = EXCLUDED.member_type,
            role = EXCLUDED.role",
    )
    .bind(&channel_id)
    .bind(&body.member_id)
    .bind(&body.member_type)
    .bind(&role)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(
        json!({"channel_id": channel_id, "member_id": body.member_id, "member_type": body.member_type, "role": role}),
    ))
}

pub async fn remove_channel_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, member_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id = $1 AND member_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"removed": true})))
}

/// Count human 'owner' members of a channel — used by the last-owner guards so a
/// leave/demote can't orphan the channel (leave it with no owner who can manage it).
async fn channel_owner_count(state: &AppState, channel_id: &str) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM channel_memberships
         WHERE channel_id = $1 AND member_type = 'user' AND role = 'owner'",
    )
    .bind(channel_id)
    .fetch_one(&state.db)
    .await?)
}

/// POST /api/v1/channels/{channel_id}/leave — the caller removes their OWN
/// membership. Any member may leave EXCEPT the last owner (must transfer or delete
/// first) and DMs (leaving a DM is meaningless). Distinct from remove_channel_member,
/// which is admin-only.
pub async fn leave_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?;
    let role = role.ok_or(AppError::NotFound)?;

    let channel_type: Option<String> =
        sqlx::query_scalar("SELECT type FROM channels WHERE channel_id = $1")
            .bind(&channel_id)
            .fetch_optional(&state.db)
            .await?;
    if channel_type.as_deref() == Some("dm") {
        return Err(AppError::BadRequest("cannot leave a direct message".into()));
    }
    if role == "owner" && channel_owner_count(&state, &channel_id).await? <= 1 {
        return Err(AppError::Forbidden(
            "you are the last owner — transfer ownership or delete the channel first".into(),
        ));
    }
    sqlx::query(
        "DELETE FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "left": true })))
}

/// PATCH /api/v1/channels/{channel_id}/members/{member_id} — change a member's role
/// (admin-only). Refuses to demote the last owner, which would orphan the channel.
pub async fn set_channel_member_role(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, member_id)): Path<(String, String)>,
    Json(body): Json<MemberRoleRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let role = body.role;
    if !matches!(role.as_str(), "owner" | "admin" | "member" | "readonly") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, member, or readonly".into(),
        ));
    }
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM channel_memberships WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(&channel_id)
    .bind(&member_id)
    .fetch_optional(&state.db)
    .await?;
    let current = current.ok_or(AppError::NotFound)?;
    if current == "owner" && role != "owner" && channel_owner_count(&state, &channel_id).await? <= 1
    {
        return Err(AppError::Forbidden(
            "can't demote the last owner — promote another owner first".into(),
        ));
    }
    sqlx::query("UPDATE channel_memberships SET role = $3 WHERE channel_id = $1 AND member_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .bind(&role)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "member_id": member_id, "role": role })))
}

/// POST /api/v1/channels/{channel_id}/read — mark the channel read for the caller
/// by stamping `last_read_at = now()`. This is what clears the unread badge
/// computed in `list_channels` / `list_dms`. No-op (0 rows) if not a member.
pub async fn mark_channel_read(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    sqlx::query(
        "UPDATE channel_memberships SET last_read_at = NOW()
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({"ok": true})))
}
