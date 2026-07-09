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

#[derive(Deserialize)]
pub struct InvitableQuery {
    pub q: String,
}

#[derive(Serialize)]
pub struct WorkspaceInvitableDto {
    pub user_id: String,
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
        "SELECT u.user_id, u.username, u.display_name, u.avatar_url, wm.status AS membership
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
         ORDER BY u.username
         LIMIT 20",
    )
    .bind(&workspace_id)
    .bind(&me)
    .bind(&pattern)
    .bind(term)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WorkspaceInvitableDto {
                user_id: r.try_get("user_id").unwrap_or_default(),
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

/// Best-effort display name for a user (falls back to username; None if unknown).
async fn user_display_name(state: &AppState, user_id: &str) -> Option<String> {
    sqlx::query("SELECT COALESCE(display_name, username) AS name FROM users WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<Option<String>, _>("name").ok().flatten())
}

/// Workspace name — used to label an invite notification.
async fn workspace_name(state: &AppState, workspace_id: &str) -> String {
    sqlx::query("SELECT name FROM workspaces WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("name").ok())
        .unwrap_or_default()
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
    let role = body.role.unwrap_or_else(|| "member".into());
    if !matches!(role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, or member".into(),
        ));
    }
    if role == "owner" && !caller_workspace_is_owner(&state, &workspace_id, &claims).await? {
        return Err(AppError::Forbidden(
            "only an owner or a system admin can invite a member as owner".into(),
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
    if !already_member {
        // Live push to the invitee's notification center (best-effort; durable in DB).
        let inviter = user_display_name(&state, &current_user_id(&claims)).await;
        let ws_name = workspace_name(&state, &workspace_id).await;
        crate::api::notifications::push_notification(
            &state,
            &user_id,
            serde_json::json!({
                "kind": "workspace_invite",
                "workspace_id": workspace_id,
                "title": ws_name,
                "invited_by": inviter,
                "role": role,
            }),
        )
        .await;
    }
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

/// Cut a user's pending channel invites within a workspace when they leave / are
/// removed from it — a pending invite must not outlive workspace membership
/// (workspace-first), or it becomes a back-door to guest access at accept time.
/// Mirrors `channels::remove_channel_member`'s invite cleanup.
async fn purge_channel_invites_in_workspace(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM channel_invites
         WHERE user_id = $1
           AND channel_id IN (SELECT channel_id FROM channels WHERE workspace_id = $2)",
    )
    .bind(user_id)
    .bind(workspace_id)
    .execute(&state.db)
    .await?;
    Ok(())
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
    purge_channel_invites_in_workspace(&state, &workspace_id, &user_id).await?;
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
        return Err(AppError::BadRequest(
            "cannot leave your personal workspace".into(),
        ));
    }

    if role == "owner" {
        // Owner leaving reduces the owner count — serialize against concurrent
        // owner leaves/demotes: lock the owner rows, re-count, delete, in one tx.
        let mut tx = state.db.begin().await?;
        let owners = sqlx::query(
            "SELECT 1 FROM workspace_memberships
             WHERE workspace_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE",
        )
        .bind(&workspace_id)
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
            return Err(AppError::Forbidden(
                "you are the last owner — transfer ownership or delete the workspace first".into(),
            ));
        }
        sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
            .bind(&workspace_id)
            .bind(&me)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    } else {
        sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
            .bind(&workspace_id)
            .bind(&me)
            .execute(&state.db)
            .await?;
    }
    purge_channel_invites_in_workspace(&state, &workspace_id, &me).await?;
    Ok(Json(serde_json::json!({ "left": true })))
}

/// PATCH /api/v1/workspaces/{workspace_id}/members/{user_id} — change a member's
/// role (admin-only). Only an owner/global-admin may grant 'owner' or touch an
/// existing owner; refuses to demote the last owner; can't change your own role.
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
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await?;
    let current = current.ok_or(AppError::NotFound)?;

    // Privilege guard: granting 'owner' or modifying an existing owner requires the
    // caller to be an owner (or global admin) — a plain 'admin' can't mint/seize owner.
    if (role == "owner" || current == "owner")
        && !caller_workspace_is_owner(&state, &workspace_id, &claims).await?
    {
        return Err(AppError::Forbidden(
            "only an owner or a system admin can grant or change the owner role".into(),
        ));
    }

    if current == "owner" && role != "owner" {
        // Demoting an owner reduces the owner count — serialize like leave.
        let mut tx = state.db.begin().await?;
        let owners = sqlx::query(
            "SELECT 1 FROM workspace_memberships
             WHERE workspace_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE",
        )
        .bind(&workspace_id)
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
            return Err(AppError::Forbidden(
                "can't demote the last owner — promote another owner first".into(),
            ));
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
    } else {
        sqlx::query(
            "UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
        )
        .bind(&workspace_id)
        .bind(&user_id)
        .bind(&role)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(
        serde_json::json!({ "user_id": user_id, "role": role }),
    ))
}
