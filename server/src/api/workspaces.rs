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
    pub user_id: String,
    pub username: String,
    pub display_name: Option<String>,
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
pub struct RoleUpdateRequest {
    pub role: String,
}

fn current_user_id(claims: &Claims) -> String {
    claims.sub.clone()
}

async fn ensure_workspace_admin(
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
            WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')
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
    let rows = sqlx::query(
        "SELECT w.workspace_id, w.name, w.avatar_url, w.default_bot_id, w.kind
         FROM workspaces w
         LEFT JOIN workspace_memberships wm
                ON wm.workspace_id = w.workspace_id AND wm.user_id = $1 AND wm.status = 'active'
         WHERE w.kind <> 'personal'
           AND (wm.user_id IS NOT NULL OR $2 IN ('system_admin', 'admin'))
         ORDER BY w.created_at DESC",
    )
    .bind(current_user_id(&claims))
    .bind(&claims.role)
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
    let me = Uuid::parse_str(&claims.sub).map_err(|_| AppError::BadRequest("bad user id".into()))?;
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
        kind: row.try_get("kind").unwrap_or_else(|_| "personal".to_string()),
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
        "SELECT u.user_id, u.username, u.display_name, wm.role, wm.status
         FROM workspace_memberships wm
         JOIN users u ON u.user_id = wm.user_id
         WHERE wm.workspace_id = $1
         ORDER BY wm.status, u.username",
    )
    .bind(&workspace_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceMemberDto {
                user_id: r.try_get("user_id").unwrap_or_default(),
                username: r.try_get("username").unwrap_or_default(),
                display_name: r.try_get("display_name").ok(),
                role: r.try_get("role").unwrap_or_else(|_| "member".to_string()),
                status: r.try_get("status").unwrap_or_else(|_| "active".to_string()),
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

pub async fn add_workspace_member(
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
    let role = body.role.unwrap_or_else(|| "member".into());
    if !matches!(role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, or member".into(),
        ));
    }
    let user_id = resolve_user_id(&state, body.identifier.trim()).await?;
    sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (workspace_id, user_id)
            DO UPDATE SET role = EXCLUDED.role, status = 'active'",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .bind(&role)
    .execute(&state.db)
    .await?;
    Ok(Json(
        serde_json::json!({"workspace_id": workspace_id, "user_id": user_id, "role": role, "status": "active"}),
    ))
}

/// POST /api/v1/workspaces/{workspace_id}/invite — admin invites a user, who must
/// then accept. Unlike `add_workspace_member`, this creates a *pending* row that
/// does not grant access until the invitee accepts (see `accept_invite`).
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
    let role = body.role.unwrap_or_else(|| "member".into());
    if !matches!(role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, or member".into(),
        ));
    }
    let user_id = resolve_user_id(&state, body.identifier.trim()).await?;
    // DO NOTHING on conflict: never downgrade an already-active member to pending,
    // and a repeat invite is idempotent.
    let res = sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by, invited_at)
         VALUES ($1, $2, $3, 'pending', $4, NOW())
         ON CONFLICT (workspace_id, user_id) DO NOTHING",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .bind(&role)
    .bind(current_user_id(&claims))
    .execute(&state.db)
    .await?;
    let already_member = res.rows_affected() == 0;
    Ok(Json(serde_json::json!({
        "workspace_id": workspace_id,
        "user_id": user_id,
        "role": role,
        "status": if already_member { "exists" } else { "pending" },
    })))
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
    Ok(Json(serde_json::json!({"workspace_id": workspace_id, "status": "active"})))
}

/// POST /api/v1/workspaces/{workspace_id}/decline — decline a pending invite.
pub async fn decline_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    sqlx::query(
        "DELETE FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'",
    )
    .bind(&workspace_id)
    .bind(current_user_id(&claims))
    .execute(&state.db)
    .await?;
    Ok(Json(serde_json::json!({"declined": true})))
}

pub async fn remove_workspace_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((workspace_id, user_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(&workspace_id)
        .bind(&user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({"removed": true})))
}

/// Count active 'owner' members — used by the last-owner guards so a leave/demote
/// can't orphan the workspace.
async fn workspace_owner_count(state: &AppState, workspace_id: &str) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM workspace_memberships
         WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?)
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
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&me)
    .fetch_optional(&state.db)
    .await?;
    let role = role.ok_or(AppError::NotFound)?;

    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM workspaces WHERE workspace_id = $1")
            .bind(&workspace_id)
            .fetch_optional(&state.db)
            .await?;
    if kind.as_deref() == Some("personal") {
        return Err(AppError::BadRequest("cannot leave your personal workspace".into()));
    }
    if role == "owner" && workspace_owner_count(&state, &workspace_id).await? <= 1 {
        return Err(AppError::Forbidden(
            "you are the last owner — transfer ownership or delete the workspace first".into(),
        ));
    }
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(&workspace_id)
        .bind(&me)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "left": true })))
}

/// PATCH /api/v1/workspaces/{workspace_id}/members/{user_id} — change a member's
/// role (admin-only). Refuses to demote the last owner (would orphan the workspace).
pub async fn set_workspace_member_role(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((workspace_id, user_id)): Path<(String, String)>,
    Json(body): Json<RoleUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_workspace_admin(
        &state,
        &workspace_id,
        &current_user_id(&claims),
        &claims.role,
    )
    .await?;
    let role = body.role;
    if !matches!(role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, or member".into(),
        ));
    }
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await?;
    let current = current.ok_or(AppError::NotFound)?;
    if current == "owner" && role != "owner" && workspace_owner_count(&state, &workspace_id).await? <= 1
    {
        return Err(AppError::Forbidden(
            "can't demote the last owner — promote another owner first".into(),
        ));
    }
    sqlx::query("UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2")
        .bind(&workspace_id)
        .bind(&user_id)
        .bind(&role)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "user_id": user_id, "role": role })))
}
