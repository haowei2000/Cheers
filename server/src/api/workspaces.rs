use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

#[derive(Serialize)]
pub struct WorkspaceDto {
    pub workspace_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub default_bot_id: Option<String>,
    pub kind: String,
}

#[derive(Serialize)]
pub struct WorkspaceMemberDto {
    pub member_id: String,
    pub member_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    /// 'active' (joined) or 'pending' (invited, not yet accepted).
    pub status: String,
}

#[derive(Serialize)]
pub struct WorkspaceInviteDto {
    pub workspace_id: String,
    pub name: String,
    pub role: String,
    pub invited_by: Option<String>,
}

#[derive(Deserialize)]
pub struct WorkspaceCreateRequest {
    pub name: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub initial_member_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct WorkspaceUpdateRequest {
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub default_bot_id: Option<String>,
}

#[derive(Deserialize)]
pub struct InviteMemberRequest {
    pub identifier: String,
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct AddWorkspaceMemberRequest {
    pub member_id: String,
    pub member_type: String,
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct RoleUpdateRequest {
    pub role: String,
}

fn current_user_id(claims: &Claims) -> String {
    claims.sub.clone()
}

pub(crate) async fn ensure_workspace_admin(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    role: &str,
) -> Result<(), AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(());
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
              AND role IN ('owner', 'admin')
        ) AS ok",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("workspace admin required".into()))
    }
}

pub async fn list_workspaces(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<WorkspaceDto>>, AppError> {
    // Membership-only: workspaces are private — you see one only after being
    // granted access (active membership). No global-admin bypass here: admins
    // keep management powers on specific workspaces, but their rail isn't a
    // directory of everyone's spaces.
    let rows = sqlx::query(
        "SELECT w.workspace_id, w.name, w.avatar_url, w.default_bot_id, w.kind
         FROM workspaces w
         JOIN workspace_memberships wm
                ON wm.workspace_id = w.workspace_id AND wm.user_id = $1 AND wm.status = 'active'
         WHERE w.kind <> 'personal'
         ORDER BY w.created_at DESC",
    )
    .bind(current_user_id(&claims))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceDto {
                workspace_id: r.try_get("workspace_id").unwrap_or_default(),
                name: r.try_get("name").unwrap_or_default(),
                avatar_url: r.try_get("avatar_url").ok(),
                default_bot_id: r.try_get("default_bot_id").ok(),
                kind: r.try_get("kind").unwrap_or_else(|_| "team".to_string()),
            })
            .collect(),
    ))
}

/// GET /api/v1/workspaces/personal — the caller's personal workspace (get-or-create). It's
/// the user's private space + DM anchor; not membership-listed, so it has its own endpoint.
pub async fn get_personal_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<WorkspaceDto>, AppError> {
    let me =
        Uuid::parse_str(&claims.sub).map_err(|_| AppError::BadRequest("bad user id".into()))?;
    let ws_id = crate::domain::workspaces::get_or_create_personal_workspace(&state.db, me).await?;
    let row = sqlx::query(
        "SELECT workspace_id, name, avatar_url, default_bot_id, kind
         FROM workspaces WHERE workspace_id = $1",
    )
    .bind(ws_id.to_string())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(WorkspaceDto {
        workspace_id: row.try_get("workspace_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        avatar_url: row.try_get("avatar_url").ok(),
        default_bot_id: row.try_get("default_bot_id").ok(),
        kind: row
            .try_get("kind")
            .unwrap_or_else(|_| "personal".to_string()),
    }))
}

pub async fn create_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<WorkspaceCreateRequest>,
) -> Result<Json<WorkspaceDto>, AppError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let workspace_id = Uuid::new_v4().to_string();
    let user_id = current_user_id(&claims);
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "INSERT INTO workspaces (workspace_id, name, avatar_url, kind)
         VALUES ($1, $2, $3, 'team')
         RETURNING workspace_id, name, avatar_url, default_bot_id, kind",
    )
    .bind(&workspace_id)
    .bind(name)
    .bind(&body.avatar_url)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING")
        .bind(&workspace_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    for member_id in body.initial_member_ids {
        sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING")
            .bind(&workspace_id)
            .bind(member_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(WorkspaceDto {
        workspace_id: row.try_get("workspace_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        avatar_url: row.try_get("avatar_url").ok(),
        default_bot_id: row.try_get("default_bot_id").ok(),
        kind: row.try_get("kind").unwrap_or_else(|_| "team".to_string()),
    }))
}

pub async fn update_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
    Json(body): Json<WorkspaceUpdateRequest>,
) -> Result<Json<WorkspaceDto>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let row = sqlx::query(
        "UPDATE workspaces
         SET name = COALESCE($2, name),
             avatar_url = COALESCE($3, avatar_url),
             default_bot_id = COALESCE($4, default_bot_id)
         WHERE workspace_id = $1
         RETURNING workspace_id, name, avatar_url, default_bot_id, kind",
    )
    .bind(&workspace_id)
    .bind(body.name)
    .bind(body.avatar_url)
    .bind(body.default_bot_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(WorkspaceDto {
        workspace_id: row.try_get("workspace_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        avatar_url: row.try_get("avatar_url").ok(),
        default_bot_id: row.try_get("default_bot_id").ok(),
        kind: row.try_get("kind").unwrap_or_else(|_| "team".to_string()),
    }))
}

pub async fn delete_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    sqlx::query("DELETE FROM workspaces WHERE workspace_id = $1")
        .bind(&workspace_id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({"deleted": true})))
}

pub async fn list_workspace_members(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<WorkspaceMemberDto>>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let rows = sqlx::query(
        "SELECT u.user_id AS member_id, 'user' AS member_type, u.username,
                u.display_name, u.avatar_url, wm.role, wm.status
         FROM workspace_memberships wm
         JOIN users u ON u.user_id = wm.user_id
         WHERE wm.workspace_id = $1
         UNION ALL
         SELECT b.bot_id AS member_id, 'bot' AS member_type, b.username,
                b.display_name, b.avatar_url, wbm.role, 'active' AS status
         FROM workspace_bot_memberships wbm
         JOIN bot_accounts b ON b.bot_id = wbm.bot_id
         WHERE wbm.workspace_id = $1
         ORDER BY status, username",
    )
    .bind(&workspace_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceMemberDto {
                member_id: r.try_get("member_id").unwrap_or_default(),
                member_type: r.try_get("member_type").unwrap_or_else(|_| "user".into()),
                user_id: (r.try_get::<String, _>("member_type").ok().as_deref() == Some("user"))
                    .then(|| r.try_get("member_id").unwrap_or_default()),
                bot_id: (r.try_get::<String, _>("member_type").ok().as_deref() == Some("bot"))
                    .then(|| r.try_get("member_id").unwrap_or_default()),
                username: r.try_get("username").unwrap_or_default(),
                display_name: r.try_get("display_name").ok(),
                avatar_url: r.try_get("avatar_url").ok(),
                role: r.try_get("role").unwrap_or_else(|_| "member".to_string()),
                status: r.try_get("status").unwrap_or_else(|_| "active".to_string()),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct InvitableQuery {
    pub q: String,
}

#[derive(Serialize)]
pub struct WorkspaceInvitableDto {
    pub member_id: String,
    pub member_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// Existing membership in this workspace: 'active' | 'pending' | null (none).
    pub membership: Option<String>,
}

/// GET /api/v1/workspaces/{workspace_id}/invitable?q= — candidate search for the
/// invite box (admin-gated like the rest of member management). Mirrors the
/// channel-invite privacy stance (`domain::invitable`): there is NO site-wide name
/// directory, so substring search covers only the caller's ACCEPTED FRIENDS; anyone
/// else is findable by EXACT username or email (you must already know them). Existing
/// members aren't hidden — they come back tagged with their membership status so the
/// UI can grey them out.
pub async fn search_workspace_invitable(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<InvitableQuery>,
) -> Result<Json<Vec<WorkspaceInvitableDto>>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let term = q.q.trim();
    if term.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let me = current_user_id(&claims);
    let pattern = format!("%{}%", crate::domain::messages::escape_like_pattern(term));
    let rows = sqlx::query(
        "SELECT u.user_id AS member_id, 'user' AS member_type, u.username,
                u.display_name, u.avatar_url, wm.status AS membership
         FROM users u
         LEFT JOIN workspace_memberships wm
                ON wm.workspace_id = $1 AND wm.user_id = u.user_id
         WHERE u.is_deleted = FALSE
           AND u.user_id <> $2
           AND (
               (
                   (u.username ILIKE $3 OR u.display_name ILIKE $3)
                   AND EXISTS (
                       SELECT 1 FROM friendships f
                       WHERE f.status = 'accepted'
                         AND ((f.user_id = $2 AND f.friend_id = u.user_id)
                           OR (f.friend_id = $2 AND f.user_id = u.user_id))
                   )
               )
               OR u.username = $4
               OR u.email = $4
           )
         UNION ALL
         SELECT b.bot_id AS member_id, 'bot' AS member_type, b.username,
                b.display_name, b.avatar_url,
                CASE WHEN wbm.bot_id IS NULL THEN NULL ELSE 'active' END AS membership
         FROM bot_accounts b
         LEFT JOIN workspace_bot_memberships wbm
                ON wbm.workspace_id = $1 AND wbm.bot_id = b.bot_id
         WHERE b.is_disabled = FALSE
           AND ($5::boolean OR b.created_by = $2)
           AND (b.username ILIKE $3 OR b.display_name ILIKE $3 OR b.bot_id = $4)
         ORDER BY username
         LIMIT 20",
    )
    .bind(&workspace_id)
    .bind(&me)
    .bind(&pattern)
    .bind(term)
    .bind(matches!(claims.role.as_str(), "system_admin" | "admin"))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceInvitableDto {
                member_id: r.try_get("member_id").unwrap_or_default(),
                member_type: r.try_get("member_type").unwrap_or_else(|_| "user".into()),
                user_id: (r.try_get::<String, _>("member_type").ok().as_deref() == Some("user"))
                    .then(|| r.try_get("member_id").unwrap_or_default()),
                bot_id: (r.try_get::<String, _>("member_type").ok().as_deref() == Some("bot"))
                    .then(|| r.try_get("member_id").unwrap_or_default()),
                username: r.try_get("username").unwrap_or_default(),
                display_name: r.try_get("display_name").ok(),
                avatar_url: r.try_get("avatar_url").ok(),
                membership: r.try_get("membership").ok(),
            })
            .collect(),
    ))
}

async fn resolve_user_id(state: &AppState, identifier: &str) -> Result<String, AppError> {
    let row =
        sqlx::query("SELECT user_id FROM users WHERE user_id = $1 OR username = $1 OR email = $1")
            .bind(identifier)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    Ok(row.try_get("user_id").unwrap_or_default())
}

async fn add_workspace_member_record(
    state: &AppState,
    claims: &Claims,
    workspace_id: &str,
    member_id: &str,
    member_type: &str,
    requested_role: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let role = requested_role.unwrap_or_else(|| "member".into());
    match member_type {
        "user" => {
            if !matches!(role.as_str(), "owner" | "admin" | "member") {
                return Err(AppError::BadRequest(
                    "a user's workspace role must be owner, admin, or member".into(),
                ));
            }
            if role == "owner" && !caller_workspace_is_owner(state, workspace_id, claims).await? {
                return Err(AppError::Forbidden(
                    "only an owner or a system admin can invite a member as owner".into(),
                ));
            }
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE user_id = $1 AND is_deleted = FALSE)",
            )
            .bind(member_id)
            .fetch_one(&state.db)
            .await?;
            if !exists {
                return Err(AppError::NotFound);
            }
            let written = sqlx::query(
                "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by, invited_at)
                 VALUES ($1, $2, $3, 'pending', $4, NOW())
                 ON CONFLICT (workspace_id, user_id) DO NOTHING",
            )
            .bind(workspace_id).bind(member_id).bind(&role).bind(current_user_id(claims))
            .execute(&state.db).await?.rows_affected();
            if written > 0 {
                crate::api::notifications::deliver_notification_by_id(
                    state,
                    member_id,
                    &format!("workspace:{workspace_id}"),
                )
                .await?;
            }
            Ok(serde_json::json!({
                "workspace_id": workspace_id, "member_id": member_id,
                "member_type": "user", "role": role,
                "status": if written == 0 { "exists" } else { "pending" },
            }))
        }
        "bot" => {
            if !matches!(role.as_str(), "member" | "readonly") {
                return Err(AppError::BadRequest(
                    "a bot's workspace role must be member or readonly".into(),
                ));
            }
            let bot =
                sqlx::query("SELECT created_by, is_disabled FROM bot_accounts WHERE bot_id = $1")
                    .bind(member_id)
                    .fetch_optional(&state.db)
                    .await?
                    .ok_or(AppError::NotFound)?;
            let owner: Option<String> = bot.try_get("created_by").ok().flatten();
            if bot.try_get::<bool, _>("is_disabled").unwrap_or(false) {
                return Err(AppError::BadRequest(
                    "disabled bot cannot be invited".into(),
                ));
            }
            let platform_admin = matches!(claims.role.as_str(), "system_admin" | "admin");
            if !platform_admin && owner.as_deref() != Some(claims.sub.as_str()) {
                return Err(AppError::Forbidden(
                    "only the bot owner or an admin may add this bot to a workspace".into(),
                ));
            }
            let written = sqlx::query(
                "INSERT INTO workspace_bot_memberships (workspace_id, bot_id, role, added_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (workspace_id, bot_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(member_id)
            .bind(&role)
            .bind(current_user_id(claims))
            .execute(&state.db)
            .await?
            .rows_affected();
            Ok(serde_json::json!({
                "workspace_id": workspace_id, "member_id": member_id,
                "member_type": "bot", "role": role,
                "status": if written == 0 { "exists" } else { "active" },
            }))
        }
        _ => Err(AppError::BadRequest(
            "member_type must be user or bot".into(),
        )),
    }
}

/// POST /api/v1/workspaces/{workspace_id}/members — the polymorphic member
/// endpoint shared by user and bot invitations.
pub async fn add_workspace_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
    Json(body): Json<AddWorkspaceMemberRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    Ok(Json(
        add_workspace_member_record(
            &state,
            &claims,
            &workspace_id,
            &body.member_id,
            &body.member_type,
            body.role,
        )
        .await?,
    ))
}

/// POST /api/v1/workspaces/{workspace_id}/invite — an admin invites a user, who must
/// then accept. Creates a *pending* row that grants no access until accepted (see
/// `accept_invite`). Every membership now flows through this path — there is no
/// consent-free "add directly" anymore.
pub async fn invite_workspace_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
    Json(body): Json<InviteMemberRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let user_id = resolve_user_id(&state, body.identifier.trim()).await?;
    Ok(Json(
        add_workspace_member_record(&state, &claims, &workspace_id, &user_id, "user", body.role)
            .await?,
    ))
}

/// GET /api/v1/workspaces/invites — the caller's pending workspace invites.
pub async fn list_my_invites(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<WorkspaceInviteDto>>, AppError> {
    let rows = sqlx::query(
        "SELECT w.workspace_id, w.name, wm.role,
                COALESCE(iu.display_name, iu.username) AS invited_by
         FROM workspace_memberships wm
         JOIN workspaces w ON w.workspace_id = wm.workspace_id
         LEFT JOIN users iu ON iu.user_id = wm.invited_by
         WHERE wm.user_id = $1 AND wm.status = 'pending'
         ORDER BY wm.invited_at DESC NULLS LAST",
    )
    .bind(current_user_id(&claims))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceInviteDto {
                workspace_id: r.try_get("workspace_id").unwrap_or_default(),
                name: r.try_get("name").unwrap_or_default(),
                role: r.try_get("role").unwrap_or_else(|_| "member".to_string()),
                invited_by: r.try_get("invited_by").ok(),
            })
            .collect(),
    ))
}

/// POST /api/v1/workspaces/{workspace_id}/accept — accept a pending invite.
pub async fn accept_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let res = sqlx::query(
        "UPDATE workspace_memberships SET status = 'active'
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'",
    )
    .bind(&workspace_id)
    .bind(current_user_id(&claims))
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("workspace:{workspace_id}"),
    )
    .await;
    crate::api::notifications::deliver_unlocked_channel_invites(&state, &claims.sub, &workspace_id)
        .await?;
    Ok(Json(
        serde_json::json!({"workspace_id": workspace_id, "status": "active"}),
    ))
}

/// POST /api/v1/workspaces/{workspace_id}/decline — decline a pending invite.
pub async fn decline_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let channel_ids =
        crate::domain::workspaces::decline_pending_invite(&state.db, &workspace_id, &claims.sub)
            .await?;
    for channel_id in channel_ids {
        crate::api::notifications::resolve_notification(
            &state,
            &claims.sub,
            &format!("channel:{channel_id}"),
        )
        .await;
    }
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("workspace:{workspace_id}"),
    )
    .await;
    Ok(Json(serde_json::json!({"declined": true})))
}

/// Remove a human from every non-DM channel in a workspace before removing the
/// workspace membership. The deferred DB constraint is the final guard; this
/// helper owns the domain cleanup and realtime revocation.
async fn detach_workspace_member(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    let detached =
        crate::domain::workspaces::detach_member(&state.db, workspace_id, user_id).await?;
    for channel_id in detached.invite_channel_ids {
        crate::api::notifications::resolve_notification(
            state,
            user_id,
            &format!("channel:{channel_id}"),
        )
        .await;
    }
    crate::api::notifications::resolve_notification(
        state,
        user_id,
        &format!("workspace:{workspace_id}"),
    )
    .await;
    for channel_id in detached.channel_ids {
        if let (Ok(uid), Ok(cid)) = (Uuid::parse_str(user_id), Uuid::parse_str(&channel_id)) {
            state
                .conn_manager
                .revoke_channel_subscriptions(uid, cid)
                .await;
            crate::gateway::presence::broadcast_presence(state, cid).await;
        }
    }
    Ok(())
}

pub async fn remove_workspace_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((workspace_id, member_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let bot_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_bot_memberships WHERE workspace_id = $1 AND bot_id = $2)",
    ).bind(&workspace_id).bind(&member_id).fetch_one(&state.db).await?;
    if bot_member {
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "DELETE FROM channel_memberships cm USING channels c
             WHERE cm.channel_id = c.channel_id AND c.workspace_id = $1
               AND cm.member_id = $2 AND cm.member_type = 'bot'",
        )
        .bind(&workspace_id)
        .bind(&member_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM workspace_bot_memberships WHERE workspace_id = $1 AND bot_id = $2",
        )
        .bind(&workspace_id)
        .bind(&member_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    } else {
        detach_workspace_member(&state, &workspace_id, &member_id).await?;
    }
    Ok(Json(serde_json::json!({"removed": true})))
}

/// Whether the caller may grant/revoke the OWNER rank in this workspace: a global
/// admin, or a member whose own role is 'owner'. A plain 'admin' can manage members
/// but must NOT be able to mint owners (privilege escalation).
async fn caller_workspace_is_owner(
    state: &AppState,
    workspace_id: &str,
    claims: &Claims,
) -> Result<bool, AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(true);
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(workspace_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?;
    Ok(role.as_deref() == Some("owner"))
}

/// POST /api/v1/workspaces/{workspace_id}/leave — the caller removes their OWN
/// membership. Any member may leave EXCEPT the last owner (transfer or delete first)
/// and the personal workspace. Distinct from remove_workspace_member (admin-only).
pub async fn leave_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let me = current_user_id(&claims);
    let membership_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2)",
    )
    .bind(&workspace_id)
    .bind(&me)
    .fetch_one(&state.db)
    .await?;
    if !membership_exists {
        return Err(AppError::NotFound);
    }

    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM workspaces WHERE workspace_id = $1")
            .bind(&workspace_id)
            .fetch_optional(&state.db)
            .await?;
    if kind.as_deref() == Some("personal") {
        return Err(AppError::BadRequest(
            "cannot leave your personal workspace".into(),
        ));
    }

    detach_workspace_member(&state, &workspace_id, &me).await?;
    Ok(Json(serde_json::json!({ "left": true })))
}

/// PATCH /api/v1/workspaces/{workspace_id}/members/{user_id} — change a member's
/// role (admin-only). Only an owner/global-admin may grant 'owner' or touch an
/// existing owner; refuses to demote the last owner; can't change your own role.
pub async fn set_workspace_member_role(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((workspace_id, member_id)): Path<(String, String)>,
    Json(body): Json<RoleUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let bot_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_bot_memberships WHERE workspace_id = $1 AND bot_id = $2)",
    ).bind(&workspace_id).bind(&member_id).fetch_one(&state.db).await?;
    if bot_member {
        if !matches!(body.role.as_str(), "member" | "readonly") {
            return Err(AppError::BadRequest(
                "a bot's workspace role must be member or readonly".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE workspace_bot_memberships SET role = $3 WHERE workspace_id = $1 AND bot_id = $2",
        ).bind(&workspace_id).bind(&member_id).bind(&body.role).execute(&state.db).await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound);
        }
        return Ok(Json(serde_json::json!({
            "member_id": member_id, "member_type": "bot", "role": body.role,
        })));
    }
    let user_id = member_id;
    if user_id == current_user_id(&claims) {
        return Err(AppError::BadRequest(
            "use leave or transfer ownership to change your own role".into(),
        ));
    }
    let role = body.role;
    if !matches!(role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, or member".into(),
        ));
    }
    // Serialize every role write with leave/removal. Both paths lock this same
    // workspace row before revalidating authority and the active-owner count.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE")
        .bind(&workspace_id)
        .fetch_one(&mut *tx)
        .await?;
    let locked_current: String = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let platform_admin = matches!(claims.role.as_str(), "system_admin" | "admin");
    let locked_caller_role: Option<String> = if platform_admin {
        None
    } else {
        sqlx::query_scalar(
            "SELECT role FROM workspace_memberships
             WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
        )
        .bind(&workspace_id)
        .bind(&claims.sub)
        .fetch_optional(&mut *tx)
        .await?
    };
    if !platform_admin && !matches!(locked_caller_role.as_deref(), Some("owner" | "admin")) {
        return Err(AppError::Forbidden("workspace admin required".into()));
    }
    // Granting 'owner' or modifying an existing owner requires a workspace owner
    // (or platform admin); a plain workspace admin cannot mint or seize owners.
    if (role == "owner" || locked_current == "owner")
        && !platform_admin
        && locked_caller_role.as_deref() != Some("owner")
    {
        return Err(AppError::Forbidden(
            "only an owner or a system admin can grant or change the owner role".into(),
        ));
    }
    if locked_current == "owner" && role != "owner" {
        let owner_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workspace_memberships
             WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'",
        )
        .bind(&workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        if owner_count <= 1 {
            return Err(AppError::Forbidden(
                "can't demote the last owner — promote another owner first".into(),
            ));
        }
    }
    sqlx::query(
        "UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .bind(&role)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(
        serde_json::json!({ "user_id": user_id, "role": role }),
    ))
}

#[cfg(test)]
mod tests {
    use super::AddWorkspaceMemberRequest;

    #[test]
    fn workspace_member_request_is_polymorphic() {
        let request: AddWorkspaceMemberRequest = serde_json::from_value(serde_json::json!({
            "member_id": "bot-id",
            "member_type": "bot",
            "role": "member"
        }))
        .expect("valid member request");
        assert_eq!(request.member_id, "bot-id");
        assert_eq!(request.member_type, "bot");
        assert_eq!(request.role.as_deref(), Some("member"));
    }
}
