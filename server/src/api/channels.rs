use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    api::middleware::Claims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};

#[derive(Serialize)]
pub struct ChannelDto {
    pub channel_id: String,
    pub workspace_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    #[serde(rename = "type")]
    pub channel_type: String,
    /// Interaction kind, orthogonal to public/private/DM access semantics.
    pub kind: String,
    /// Message presentation, orthogonal to access and interaction kind.
    /// `chat` is chronological with own messages on the right; `discuss`
    /// groups replies below their root and keeps every participant on the left.
    pub conversation_mode: String,
    pub purpose: Option<String>,
    pub auto_assist: bool,
    pub allow_member_invites: bool,
    pub allow_bot_adds: bool,
    /// Messages newer than the caller's `last_read_at` not sent by the caller.
    /// 0 for queries that don't compute it (create/get/update single-channel).
    #[serde(default)]
    pub unread_count: i64,
    /// Of those unread messages, how many @mention the caller — the "you were
    /// mentioned here" signal for a distinct sidebar badge. Reverse lookup on
    /// `message_mentions` (the `ix_message_mentions_member` index). 0 for queries
    /// that don't compute it.
    #[serde(default)]
    pub mention_count: i64,
    /// Whether the caller has a `channel_memberships` row. Workspace members see
    /// public channels they haven't joined yet (Slack model) — those come back
    /// `false` so the client renders a join prompt instead of the composer.
    /// Queries that only ever return the caller's own channels leave it `true`.
    pub is_member: bool,
    /// The caller's role in this channel (`owner`/`admin`/`member`/`bot`), or
    /// null when the caller isn't a direct channel member (e.g. a workspace
    /// member viewing a public channel they haven't joined). Drives
    /// member/permission surfaces. `system_admin` is surfaced as "owner".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_role: Option<String>,
    /// True when the caller may administer this channel (owner, admin, or
    /// system_admin). Gates transcription/moderation/retention controls.
    #[serde(default)]
    pub can_manage: bool,
}

#[derive(Deserialize)]
pub struct ChannelCreateRequest {
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    pub kind: Option<String>,
    pub conversation_mode: Option<String>,
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
    pub conversation_mode: Option<String>,
    pub allow_member_invites: Option<bool>,
    pub allow_bot_adds: Option<bool>,
}

#[derive(Deserialize)]
pub struct ChannelNotificationPreferenceRequest {
    pub muted: bool,
}

#[derive(Deserialize)]
pub struct AddMemberRequest {
    pub member_id: String,
    pub member_type: String,
    pub role: Option<String>,
    /// Optional (bot only): pin the PRIMARY session's ACP working directory in this
    /// channel. MUST be absolute; validated against the bot connector's allowed_roots
    /// on the spot (docs/arch/SESSION_WORKDIR_ROOTSET.md). Immutable once set.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Optional (bot only): extra roots for the primary session's effective root set
    /// (ACP `additionalDirectories`). Each MUST be absolute.
    #[serde(default)]
    pub additional_dirs: Option<Vec<String>>,
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
        avatar_url: row.try_get("avatar_url").ok(),
        channel_type: row.try_get("type").unwrap_or_else(|_| "public".to_string()),
        kind: row.try_get("kind").unwrap_or_else(|_| "text".to_string()),
        conversation_mode: row
            .try_get("conversation_mode")
            .unwrap_or_else(|_| "chat".to_string()),
        purpose: row.try_get("purpose").ok(),
        auto_assist: row.try_get("auto_assist").unwrap_or(false),
        allow_member_invites: row.try_get("allow_member_invites").unwrap_or(true),
        allow_bot_adds: row.try_get("allow_bot_adds").unwrap_or(true),
        unread_count: row.try_get("unread_count").unwrap_or(0),
        mention_count: row.try_get("mention_count").unwrap_or(0),
        // Only the workspace-scoped listing computes this; the other queries are
        // membership-gated (or membership-joined) already, so absent → true.
        is_member: row.try_get("is_member").unwrap_or(true),
        // Only the workspace-scoped listing computes these; other queries leave
        // them absent → None / false (no role gating needed for create/get/update).
        my_role: row.try_get("my_role").ok(),
        can_manage: row.try_get("can_manage").unwrap_or(false),
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

pub(crate) async fn ensure_channel_admin(
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
    //
    // Visibility (Slack model): channels you belong to, plus PUBLIC channels of
    // workspaces you're an active member of (joinable via POST /channels/:id/join).
    // Private channels never show to non-members. Unread/mention counts are only
    // meaningful for members — non-members get 0, not "every message ever".
    let rows = sqlx::query(
        // Both counts come from ONE lateral scan of the unread message range instead
        // of two independent correlated count(*) subqueries. The non-member guard
        // (`cm.member_id IS NOT NULL`) lives inside the lateral WHERE, so non-members
        // scan zero rows and an aggregate over zero rows still yields one row of 0 —
        // preserving the old CASE-based "non-members get 0" invariant.
        "SELECT DISTINCT c.channel_id, c.workspace_id, c.name, c.avatar_url, c.type, c.kind,
                c.conversation_mode, c.purpose,
                c.auto_assist, c.allow_member_invites, c.allow_bot_adds, c.created_at,
                (cm.member_id IS NOT NULL) AS is_member,
                cm.role AS my_role,
                (cm.role IN ('owner', 'admin') OR $3::boolean) AS can_manage,
                counts.unread_count,
                counts.mention_count
         FROM channels c
         LEFT JOIN channel_memberships cm ON cm.channel_id = c.channel_id AND cm.member_id = $1
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $1
                AND wm.status = 'active'
         CROSS JOIN LATERAL (
             -- Bounded unread scan: cap at the newest 100 unread messages so a huge
             -- backlog can't force an unbounded count. `unread_count` is min(actual,
             -- 100) (99+ semantics); `mention_count` is computed over the same
             -- capped window via a single LEFT JOIN (PK (msg_id, member_id) ⇒ at most
             -- one match per message) rather than a per-row correlated EXISTS. The
             -- non-member guard (`cm.member_id IS NOT NULL`) stays inside the window:
             -- a non-member's window is empty, so both counts are 0 as before.
             SELECT count(*) AS unread_count,
                    count(mm.msg_id) AS mention_count
             FROM messages m
             LEFT JOIN message_mentions mm
                    ON mm.msg_id = m.msg_id
                   AND mm.member_id = $1 AND mm.member_type = 'user'
             WHERE m.msg_id IN (
                 SELECT m2.msg_id
                 FROM messages m2
                 WHERE cm.member_id IS NOT NULL
                   AND m2.channel_id = c.channel_id
                   AND m2.is_partial = FALSE
                   AND m2.sender_id <> $1
                   AND m2.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
                 ORDER BY m2.created_at DESC
                 LIMIT 100
             )
         ) counts
         WHERE c.type != 'dm'
           AND c.archived_at IS NULL
           AND (cm.member_id IS NOT NULL
                OR (wm.user_id IS NOT NULL AND c.type = 'public'))
           AND ($2::text IS NULL OR c.workspace_id = $2)
         ORDER BY c.created_at DESC",
    )
    .bind(&claims.sub)
    .bind(&q.workspace_id)
    .bind(claims.role == "system_admin" || claims.role == "admin")
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
    let me =
        Uuid::parse_str(&claims.sub).map_err(|_| AppError::BadRequest("bad user id".into()))?;
    let (target_id_raw, is_bot) = match (body.target_user_id, body.target_bot_id) {
        (Some(u), None) => (u, false),
        (None, Some(b)) => (b, true),
        _ => {
            return Err(AppError::BadRequest(
                "exactly one of target_user_id / target_bot_id".into(),
            ))
        }
    };
    let target_id = Uuid::parse_str(&target_id_raw)
        .map_err(|_| AppError::BadRequest("target id must be a uuid".into()))?;
    if !is_bot && !users_can_dm(&state.db, &claims.sub, &target_id.to_string()).await? {
        return Err(AppError::Forbidden(
            "you can only DM friends or people you share a channel with".into(),
        ));
    }
    if is_bot {
        let visible: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM bot_accounts b
                WHERE b.bot_id = $1 AND b.is_disabled = FALSE AND (
                    $3::boolean OR b.created_by = $2 OR EXISTS (
                        SELECT 1 FROM channel_memberships bm
                        JOIN channel_memberships um ON um.channel_id = bm.channel_id
                        WHERE bm.member_id = b.bot_id AND bm.member_type = 'bot'
                          AND um.member_id = $2 AND um.member_type = 'user'
                    )
                )
             )",
        )
        .bind(target_id.to_string())
        .bind(&claims.sub)
        .bind(matches!(claims.role.as_str(), "system_admin" | "admin"))
        .fetch_one(&state.db)
        .await?;
        if !visible {
            return Err(AppError::NotFound);
        }
    }
    let opened = crate::domain::dms::open_dm(
        &state.db,
        crate::domain::dms::Participant::User(me),
        if is_bot {
            crate::domain::dms::Participant::Bot(target_id)
        } else {
            crate::domain::dms::Participant::User(target_id)
        },
    )
    .await?;
    let channel_id = opened.channel_id;
    if opened.created && !is_bot {
        state
            .fanout
            .broadcast_user(target_id, dm_created_frame(channel_id))
            .await;
    }
    let row = sqlx::query(
        "SELECT channel_id, workspace_id, name, avatar_url, type, kind, conversation_mode,
                purpose, auto_assist,
                allow_member_invites, allow_bot_adds
         FROM channels WHERE channel_id = $1",
    )
    .bind(channel_id.to_string())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(dto(row)))
}

fn dm_created_frame(channel_id: Uuid) -> WireFrame {
    WireFrame::user("dm_created", json!({ "channel_id": channel_id }))
}

fn bot_add_requires_session_create(
    caller_is_owner: bool,
    legacy_admin: bool,
    platform_admin: bool,
) -> bool {
    !caller_is_owner && !legacy_admin && !platform_admin
}

fn can_create_channel(workspace_role: Option<&str>, platform_admin: bool) -> bool {
    workspace_role.is_some() || platform_admin
}

fn pending_channel_invite_status(workspace_status: Option<&str>) -> &'static str {
    if workspace_status == Some("active") {
        "pending"
    } else {
        "pending_workspace"
    }
}

/// GET /api/v1/channels/dm — the caller's DMs (type='dm' channels they're a member of).
/// Access is membership-driven (independent of the anchor workspace). Each row carries
/// `peer_name` (the OTHER participant) so the client can label the nameless DM channel.
pub async fn list_dms(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT c.channel_id, c.workspace_id, c.name, c.avatar_url, c.type, c.kind,
                c.conversation_mode, c.purpose, c.auto_assist,
                c.allow_member_invites, c.allow_bot_adds,
                COALESCE((
                    -- Bounded unread scan: cap at the newest 100 unread messages so a
                    -- huge backlog can't force an unbounded count (min(actual, 100),
                    -- i.e. 99+ semantics).
                    SELECT count(*) FROM messages msg
                    WHERE msg.msg_id IN (
                        SELECT m2.msg_id FROM messages m2
                        WHERE m2.channel_id = c.channel_id
                          AND m2.is_partial = FALSE
                          AND m2.sender_id <> $1
                          AND m2.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
                        ORDER BY m2.created_at DESC
                        LIMIT 100
                    )
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
    let workspace_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(&body.workspace_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?;
    let platform_admin = matches!(claims.role.as_str(), "system_admin" | "admin");
    if !can_create_channel(workspace_role.as_deref(), platform_admin) {
        return Err(AppError::Forbidden("workspace member required".into()));
    }
    let activate_creator_membership = workspace_role.is_none() && platform_admin;
    let creator_is_workspace_admin =
        matches!(workspace_role.as_deref(), Some("owner" | "admin")) || platform_admin;
    let channel_id = Uuid::new_v4().to_string();
    let channel_type = body.channel_type.unwrap_or_else(|| "public".into());
    if !matches!(channel_type.as_str(), "public" | "private") {
        return Err(AppError::BadRequest(
            "channel type must be public or private".into(),
        ));
    }
    let kind = body.kind.unwrap_or_else(|| "text".into());
    if !matches!(kind.as_str(), "text" | "voice") {
        return Err(AppError::BadRequest(
            "channel kind must be text or voice".into(),
        ));
    }
    let conversation_mode = body.conversation_mode.unwrap_or_else(|| "chat".into());
    if !matches!(conversation_mode.as_str(), "chat" | "discuss") {
        return Err(AppError::BadRequest(
            "conversation mode must be chat or discuss".into(),
        ));
    }
    // Validate initial bots before writing the channel so a bad/unauthorized bot
    // cannot leave behind a partially-created channel. A newly-created channel
    // cannot already carry a channel-scoped session_create grant, so the only
    // immediate initial-bot paths are owner and platform administrator.
    let mut initial_bots: Vec<(String, Option<String>)> = Vec::new();
    for bot_id in &body.initial_bot_ids {
        Uuid::parse_str(bot_id)
            .map_err(|_| AppError::BadRequest("initial_bot_ids must contain bot uuids".into()))?;
        let bot = sqlx::query("SELECT created_by, is_disabled FROM bot_accounts WHERE bot_id = $1")
            .bind(bot_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
        if bot.try_get::<bool, _>("is_disabled").unwrap_or(false) {
            return Err(AppError::BadRequest(
                "disabled bot cannot be invited".into(),
            ));
        }
        let owner_id: Option<String> = bot.try_get("created_by").ok().flatten();
        if owner_id.as_deref() != Some(claims.sub.as_str())
            && !matches!(claims.role.as_str(), "system_admin" | "admin")
        {
            return Err(AppError::Forbidden(
                "initial bots must be owned by the channel creator".into(),
            ));
        }
        initial_bots.push((bot_id.clone(), owner_id));
    }
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "INSERT INTO channels
            (channel_id, workspace_id, name, type, kind, conversation_mode, purpose,
             allow_member_invites, allow_bot_adds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING channel_id, workspace_id, name, avatar_url, type, kind,
                   conversation_mode, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(&body.workspace_id)
    .bind(body.name.trim())
    .bind(&channel_type)
    .bind(&kind)
    .bind(&conversation_mode)
    .bind(&body.purpose)
    .bind(body.allow_member_invites.unwrap_or(true))
    .bind(body.allow_bot_adds.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await?;
    if activate_creator_membership {
        // Platform admins retain their channel-creation bypass, but the deferred
        // non-DM membership invariant still requires every human channel member
        // to be active in the workspace. Activate/create that membership in the
        // same transaction as the channel and its owner membership.
        sqlx::query(
            "INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
             VALUES ($1, $2, 'admin', 'active')
             ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active'",
        )
        .bind(&body.workspace_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'user', 'owner', $2) ON CONFLICT DO NOTHING")
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;
    // Founding members are invited rather than force-added. Private channels may
    // queue a channel invitation behind workspace acceptance; public-channel
    // founding invitees must already be active workspace members.
    let mut invited_users: Vec<String> = Vec::new();
    let mut workspace_invited_users: Vec<String> = Vec::new();
    for user_id in &body.initial_user_ids {
        // The creator is already the active owner (above) — never self-invite them
        // (would leave a stale pending row + a self-notification).
        if user_id == &claims.sub {
            continue;
        }
        let ws_status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM workspace_memberships
             WHERE workspace_id = $1 AND user_id = $2",
        )
        .bind(&body.workspace_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        if ws_status.as_deref() != Some("active") {
            if channel_type != "private" {
                return Err(AppError::BadRequest(
                    "initial users of a public channel must already be active workspace members"
                        .into(),
                ));
            }
            if ws_status.is_none() {
                let friend: bool = sqlx::query_scalar(
                    "SELECT EXISTS(
                        SELECT 1 FROM friendships
                        WHERE status = 'accepted'
                          AND ((user_id = $1 AND friend_id = $2)
                            OR (user_id = $2 AND friend_id = $1))
                    )",
                )
                .bind(&claims.sub)
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
                if !friend || !creator_is_workspace_admin {
                    return Err(AppError::Forbidden(
                        "inviting a non-workspace user requires an accepted friendship and workspace admin role"
                            .into(),
                    ));
                }
                let inserted = sqlx::query(
                    "INSERT INTO workspace_memberships
                        (workspace_id, user_id, role, status, invited_by, invited_at)
                     VALUES ($1, $2, 'member', 'pending', $3, NOW())
                     ON CONFLICT (workspace_id, user_id) DO NOTHING",
                )
                .bind(&body.workspace_id)
                .bind(user_id)
                .bind(&claims.sub)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if inserted > 0 {
                    workspace_invited_users.push(user_id.clone());
                }
            }
        }
        let n = sqlx::query(
            "INSERT INTO channel_invites (channel_id, user_id, role, invited_by, invited_at)
             VALUES ($1, $2, 'member', $3, NOW())
             ON CONFLICT (channel_id, user_id) DO NOTHING",
        )
        .bind(&channel_id)
        .bind(user_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n > 0 && ws_status.as_deref() == Some("active") {
            invited_users.push(user_id.clone());
        }
    }
    tx.commit().await?;

    if activate_creator_membership {
        crate::api::notifications::resolve_notification(
            &state,
            &claims.sub,
            &format!("workspace:{}", body.workspace_id),
        )
        .await;
    }

    for uid in &workspace_invited_users {
        crate::api::notifications::deliver_notification_by_id(
            &state,
            uid,
            &format!("workspace:{}", body.workspace_id),
        )
        .await?;
    }

    // Initial bots use the same owner-approval semantics as later additions.
    for (bot_id, owner_id) in &initial_bots {
        if owner_id.as_deref() == Some(claims.sub.as_str())
            || (owner_id.is_none() && matches!(claims.role.as_str(), "system_admin" | "admin"))
        {
            bind_bot_to_channel(
                &state,
                &channel_id,
                bot_id,
                "member",
                &claims.sub,
                None,
                Vec::new(),
            )
            .await?;
        } else if matches!(claims.role.as_str(), "system_admin" | "admin") {
            let owner_id = owner_id.clone().ok_or_else(|| {
                AppError::Forbidden("ownerless bots may only be added by an admin".into())
            })?;
            let inserted = sqlx::query(
                "INSERT INTO bot_channel_invites
                    (channel_id, bot_id, owner_user_id, invited_by, role)
                 VALUES ($1, $2, $3, $4, 'member')
                 ON CONFLICT (channel_id, bot_id) DO NOTHING",
            )
            .bind(&channel_id)
            .bind(bot_id)
            .bind(&owner_id)
            .bind(&claims.sub)
            .execute(&state.db)
            .await?
            .rows_affected();
            if inserted > 0 {
                crate::api::notifications::deliver_notification_by_id(
                    &state,
                    &owner_id,
                    &format!("bot-channel:{channel_id}:{bot_id}"),
                )
                .await?;
            }
        }
    }

    // Live push for any founding-member invites (best-effort; durable in DB).
    if !invited_users.is_empty() {
        for uid in &invited_users {
            crate::api::notifications::deliver_notification_by_id(
                &state,
                uid,
                &format!("channel:{channel_id}"),
            )
            .await?;
        }
    }
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
    let row = sqlx::query(
        "SELECT c.channel_id, c.workspace_id, c.name, c.avatar_url, c.type, c.kind,
                c.conversation_mode, c.purpose,
                c.auto_assist, c.allow_member_invites, c.allow_bot_adds,
                cm.role AS my_role,
                (cm.role IN ('owner', 'admin') OR $2::boolean) AS can_manage
         FROM channels c
         LEFT JOIN channel_memberships cm ON cm.channel_id = c.channel_id AND cm.member_id = $1
         WHERE c.channel_id = $3",
    )
    .bind(&claims.sub)
    .bind(claims.role == "system_admin" || claims.role == "admin")
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
    if let Some(mode) = body.conversation_mode.as_deref() {
        if !matches!(mode, "chat" | "discuss") {
            return Err(AppError::BadRequest(
                "conversation mode must be chat or discuss".into(),
            ));
        }
    }
    let row = sqlx::query(
        "UPDATE channels
         SET name = COALESCE($2, name),
             purpose = COALESCE($3, purpose),
             type = COALESCE($4, type),
             auto_assist = COALESCE($5, auto_assist),
             allow_member_invites = COALESCE($6, allow_member_invites),
             allow_bot_adds = COALESCE($7, allow_bot_adds),
             conversation_mode = COALESCE($8, conversation_mode)
         WHERE channel_id = $1
         RETURNING channel_id, workspace_id, name, avatar_url, type, kind,
                   conversation_mode, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(body.name)
    .bind(body.purpose)
    .bind(body.channel_type)
    .bind(body.auto_assist)
    .bind(body.allow_member_invites)
    .bind(body.allow_bot_adds)
    .bind(body.conversation_mode)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(dto(row)))
}

/// PUT /channels/:channel_id/notification-preference — per-user, cross-device mute.
pub async fn update_notification_preference(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<ChannelNotificationPreferenceRequest>,
) -> Result<Json<Value>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    sqlx::query(
        "INSERT INTO channel_notification_preferences (user_id, channel_id, muted)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET muted = EXCLUDED.muted, updated_at = NOW()",
    )
    .bind(&claims.sub)
    .bind(&channel_id)
    .bind(body.muted)
    .execute(&state.db)
    .await?;
    Ok(Json(
        json!({ "channel_id": channel_id, "muted": body.muted }),
    ))
}

/// GET /channels/notification-preferences — muted IDs for the current user.
pub async fn list_notification_preferences(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "SELECT channel_id FROM channel_notification_preferences WHERE user_id = $1 AND muted = TRUE",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    let channel_ids: Vec<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get("channel_id").ok())
        .collect();
    Ok(Json(json!({ "channel_ids": channel_ids })))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let pending_users: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM channel_invites WHERE channel_id = $1")
            .bind(&channel_id)
            .fetch_all(&state.db)
            .await?;
    let pending_bots =
        sqlx::query("SELECT bot_id, owner_user_id FROM bot_channel_invites WHERE channel_id = $1")
            .bind(&channel_id)
            .fetch_all(&state.db)
            .await?;
    sqlx::query("DELETE FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .execute(&state.db)
        .await?;
    // Drop every live realtime subscription to the deleted channel.
    if let Ok(cid) = Uuid::parse_str(&channel_id) {
        state.conn_manager.drop_channel(cid);
    }
    for user_id in pending_users {
        crate::api::notifications::resolve_notification(
            &state,
            &user_id,
            &format!("channel:{channel_id}"),
        )
        .await;
    }
    for row in pending_bots {
        let bot_id: String = row.try_get("bot_id").unwrap_or_default();
        let owner_id: String = row.try_get("owner_user_id").unwrap_or_default();
        crate::api::notifications::resolve_notification(
            &state,
            &owner_id,
            &format!("bot-channel:{channel_id}:{bot_id}"),
        )
        .await;
    }
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
                COALESCE(u.display_name, b.display_name) AS display_name,
                COALESCE(u.avatar_url, b.avatar_url) AS avatar_url,
                COALESCE(u.bio, b.description) AS bio,
                COALESCE(u.status_text, b.status_text) AS status_text,
                COALESCE(u.status_emoji, b.status_emoji) AS status_emoji,
                (b.binding_config->'connector_control'->'capabilities'->>'audio')::boolean
                    AS can_receive_audio
         FROM channel_memberships cm
         LEFT JOIN users u ON cm.member_type = 'user' AND u.user_id = cm.member_id
         LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.bot_id = cm.member_id
         WHERE cm.channel_id = $1
         ORDER BY cm.member_type, username",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    // is_online：用户 = 有订阅本频道的活跃浏览器连接；bot = connector 双 WS 在线。
    let online_users: std::collections::HashSet<String> = Uuid::parse_str(&channel_id)
        .map(|cid| {
            state
                .fanout
                .online_users(cid)
                .into_iter()
                .map(|id| id.to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut members = Vec::with_capacity(rows.len());
    for r in rows {
        let member_id = r.try_get::<String, _>("member_id").unwrap_or_default();
        let member_type = r.try_get::<String, _>("member_type").unwrap_or_default();
        let is_online = match member_type.as_str() {
            "user" => online_users.contains(&member_id),
            "bot" => match Uuid::parse_str(&member_id) {
                Ok(id) => state.bot_locator.is_online(id).await,
                Err(_) => false,
            },
            _ => false,
        };
        members.push(json!({
            "member_id": member_id,
            "member_type": member_type,
            "status": "active",
            "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
            "username": r.try_get::<String, _>("username").ok(),
            "display_name": r.try_get::<String, _>("display_name").ok(),
            "avatar_url": r.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
            // Profile fields for the member hovercard: bio = the long self-description
            // (users.bio, falling back to a bot's description); status = the short line.
            "bio": r.try_get::<Option<String>, _>("bio").ok().flatten(),
            "status_text": r.try_get::<Option<String>, _>("status_text").ok().flatten(),
            "status_emoji": r.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
            "is_online": is_online,
            // Bots only: whether the connector says the agent accepts audio
            // prompts (policy AND promptCapabilities.audio). NULL = unknown
            // (never connected / pre-capability connector) — treat as false.
            "can_receive_audio": r
                .try_get::<Option<bool>, _>("can_receive_audio")
                .ok()
                .flatten(),
        }));
    }
    // Pending invites (users who haven't accepted yet) — shown greyed with a badge.
    let pending = sqlx::query(
        "SELECT ci.user_id AS member_id, ci.role, u.username, u.display_name, u.avatar_url,
                u.bio, u.status_text, u.status_emoji, wm.status AS workspace_status
         FROM channel_invites ci
         JOIN users u ON u.user_id = ci.user_id
         JOIN channels c ON c.channel_id = ci.channel_id
         LEFT JOIN workspace_memberships wm
           ON wm.workspace_id = c.workspace_id AND wm.user_id = ci.user_id
         WHERE ci.channel_id = $1
         ORDER BY u.username",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    for r in pending {
        let workspace_status: Option<String> = r.try_get("workspace_status").ok().flatten();
        members.push(json!({
            "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
            "member_type": "user",
            "status": pending_channel_invite_status(workspace_status.as_deref()),
            "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
            "username": r.try_get::<String, _>("username").ok(),
            "display_name": r.try_get::<String, _>("display_name").ok(),
            "avatar_url": r.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
            "bio": r.try_get::<Option<String>, _>("bio").ok().flatten(),
            "status_text": r.try_get::<Option<String>, _>("status_text").ok().flatten(),
            "status_emoji": r.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
            "is_online": false,
            "can_receive_audio": Value::Null,
        }));
    }
    let pending_bots = sqlx::query(
        "SELECT bci.bot_id AS member_id, bci.role, b.username, b.display_name,
                b.avatar_url, b.description AS bio, b.status_text, b.status_emoji,
                bci.cwd, bci.additional_dirs
         FROM bot_channel_invites bci
         JOIN bot_accounts b ON b.bot_id = bci.bot_id
         WHERE bci.channel_id = $1
         ORDER BY b.username",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    for r in pending_bots {
        members.push(json!({
            "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
            "member_type": "bot",
            "status": "pending_owner",
            "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
            "username": r.try_get::<String, _>("username").ok(),
            "display_name": r.try_get::<String, _>("display_name").ok(),
            "avatar_url": r.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
            "bio": r.try_get::<Option<String>, _>("bio").ok().flatten(),
            "status_text": r.try_get::<Option<String>, _>("status_text").ok().flatten(),
            "status_emoji": r.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
            "is_online": false,
            "can_receive_audio": Value::Null,
            "requested_cwd": r.try_get::<Option<String>, _>("cwd").ok().flatten(),
            "requested_additional_dirs": r.try_get::<Value, _>("additional_dirs").unwrap_or_else(|_| json!([])),
        }));
    }
    Ok(Json(members))
}

#[derive(Deserialize)]
pub struct InvitableQuery {
    pub q: Option<String>,
}

/// GET /api/v1/channels/{channel_id}/invitable?q= — 统一邀请候选搜索（人 + bot）。
/// 与 add_channel_member 相同的频道管理员门槛；用户候选限 workspace 成员 ∪ 好友，
/// bot 候选按邀请 AND-gate 的 bot 侧条件过滤（owner / 平台管理员 / session_create 授权）。
pub async fn search_invitable(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Query(params): Query<InvitableQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let q = params.q.unwrap_or_default();
    let caller_role = caller_channel_role(&state, &channel_id, &claims.sub).await;
    let caller = crate::domain::invitable::InvitableCaller {
        user_id: &claims.sub,
        global_role: &claims.role,
        channel_role: &caller_role,
    };
    let items = crate::domain::invitable::search_invitable(
        &state.db,
        &state.bot_locator,
        &caller,
        &channel_id,
        &q,
    )
    .await?;
    Ok(Json(json!({ "results": items })))
}

async fn bind_bot_to_channel(
    state: &AppState,
    channel_id: &str,
    bot_id: &str,
    role: &str,
    added_by: &str,
    cwd: Option<String>,
    additional_dirs: Vec<String>,
) -> Result<(), AppError> {
    let bot_uuid = Uuid::parse_str(bot_id)
        .map_err(|_| AppError::BadRequest("member_id must be a bot uuid".into()))?;
    let provider_account_id =
        crate::domain::messages::resolve_provider_account_id_for_bot(&state.db, bot_uuid)
            .await
            .unwrap_or_else(|_| bot_id.to_string());
    let mut tx = state.db.begin().await?;
    bind_bot_to_channel_tx(
        &mut tx,
        channel_id,
        bot_id,
        &provider_account_id,
        role,
        added_by,
        cwd,
        additional_dirs,
    )
    .await?;
    tx.commit().await?;
    if let Ok(cid) = Uuid::parse_str(channel_id) {
        crate::gateway::presence::broadcast_presence(state, cid).await;
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "transactional membership write keeps the audited actor and connector scope explicit"
)]
async fn bind_bot_to_channel_tx(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
    bot_id: &str,
    provider_account_id: &str,
    role: &str,
    added_by: &str,
    cwd: Option<String>,
    additional_dirs: Vec<String>,
) -> Result<(), AppError> {
    let written = sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, 'bot', $3, $4)
         ON CONFLICT (channel_id, member_id) DO UPDATE SET role = EXCLUDED.role
         WHERE channel_memberships.member_type = EXCLUDED.member_type",
    )
    .bind(channel_id)
    .bind(bot_id)
    .bind(role)
    .bind(added_by)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if written == 0 {
        return Err(AppError::BadRequest(
            "member already exists with a different member_type".into(),
        ));
    }
    let bot_uuid = Uuid::parse_str(bot_id)
        .map_err(|_| AppError::BadRequest("member_id must be a bot uuid".into()))?;
    crate::domain::sessions::ensure_primary_session_workspace_tx(
        tx,
        bot_uuid,
        provider_account_id,
        channel_id,
        cwd.as_deref(),
        &additional_dirs,
    )
    .await?;
    Ok(())
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
    let role = body.role.clone().unwrap_or_else(|| "member".into());
    if !matches!(role.as_str(), "owner" | "admin" | "member" | "readonly") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, member, or readonly".into(),
        ));
    }
    // Only an owner (or global admin) may add a member straight in as 'owner' —
    // otherwise a plain 'admin' could mint a co-owner and seize the channel.
    if role == "owner" && !caller_channel_is_owner(&state, &channel_id, &claims).await? {
        return Err(AppError::Forbidden(
            "only an owner or a system admin can add a member as owner".into(),
        ));
    }
    // bot 的频道角色只有 member/readonly（owner/admin 对 bot 在权限层无意义）。
    if body.member_type == "bot" && !matches!(role.as_str(), "member" | "readonly") {
        return Err(AppError::BadRequest(
            "a bot's channel role must be member or readonly".into(),
        ));
    }

    // Bot-side authorization (docs/arch/SESSION_WORKDIR_ROOTSET.md): inviting a bot
    // into a channel = a `session_create` for that bot, so it is an AND-gate — the
    // caller must already be a channel admin (checked above) AND be the bot
    // owner / platform admin, or hold a `session_create` INITIATE grant for THIS
    // bot. Closes the gap where any channel admin could bind ANY bot with no
    // bot-side authorization. An optional pinned working directory rides the same
    // authorization (it can only be chosen through an invite the caller may make).
    if body.member_type == "bot" {
        let bot = sqlx::query("SELECT created_by, is_disabled FROM bot_accounts WHERE bot_id = $1")
            .bind(&body.member_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
        let owner_id: Option<String> = bot.try_get("created_by").ok().flatten();
        let disabled: bool = bot.try_get("is_disabled").unwrap_or(false);
        if disabled {
            return Err(AppError::BadRequest(
                "disabled bot cannot be invited".into(),
            ));
        }
        let caller_is_owner = owner_id.as_deref() == Some(claims.sub.as_str());
        let platform_admin = matches!(claims.role.as_str(), "system_admin" | "admin");
        let legacy_admin = owner_id.is_none() && platform_admin;
        if bot_add_requires_session_create(caller_is_owner, legacy_admin, platform_admin) {
            let caller_role = caller_channel_role(&state, &channel_id, &claims.sub).await;
            let allowed = crate::domain::acp_policy::allows(
                &state.db,
                &body.member_id,
                &channel_id,
                &claims.sub,
                &caller_role,
                "cheers/session_create",
                crate::domain::bot_event_policy::Capability::Initiate,
            )
            .await
            .unwrap_or(false); // fail-closed
            if !allowed {
                return Err(AppError::Forbidden(
                    "you are not authorized to add this bot here (needs session_create for the bot)".into(),
                ));
            }
        }
        let cwd = crate::api::session_control::normalize_workspace_path(body.cwd.clone())?;
        let additional_dirs =
            crate::api::session_control::normalize_additional_dirs(body.additional_dirs.clone())?;
        let primary_workspace = if cwd.is_some() || !additional_dirs.is_empty() {
            let bot_uuid = Uuid::parse_str(&body.member_id)
                .map_err(|_| AppError::BadRequest("member_id must be a bot uuid".into()))?;
            Some(
                crate::api::workspace::validate_workspace_paths(
                    &state,
                    bot_uuid,
                    cwd,
                    additional_dirs,
                )
                .await?,
            )
        } else {
            None
        };

        let (cwd, additional_dirs) = primary_workspace.unwrap_or((None, Vec::new()));
        if caller_is_owner || legacy_admin {
            bind_bot_to_channel(
                &state,
                &channel_id,
                &body.member_id,
                &role,
                &claims.sub,
                cwd,
                additional_dirs,
            )
            .await?;
            return Ok(Json(json!({
                "channel_id": channel_id,
                "member_id": body.member_id,
                "member_type": "bot",
                "role": role,
                "status": "active",
            })));
        }

        let owner_id = owner_id.ok_or_else(|| {
            AppError::Forbidden("ownerless bots may only be added by an admin".into())
        })?;
        let inserted = sqlx::query(
            "INSERT INTO bot_channel_invites
                (channel_id, bot_id, owner_user_id, invited_by, role, cwd, additional_dirs, invited_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
             ON CONFLICT (channel_id, bot_id) DO NOTHING",
        )
        .bind(&channel_id)
        .bind(&body.member_id)
        .bind(&owner_id)
        .bind(&claims.sub)
        .bind(&role)
        .bind(&cwd)
        .bind(json!(additional_dirs).to_string())
        .execute(&state.db)
        .await?
        .rows_affected();
        if inserted > 0 {
            crate::api::notifications::deliver_notification_by_id(
                &state,
                &owner_id,
                &format!("bot-channel:{channel_id}:{}", body.member_id),
            )
            .await?;
        }
        return Ok(Json(json!({
            "channel_id": channel_id,
            "member_id": body.member_id,
            "member_type": "bot",
            "role": role,
            "status": "pending_owner",
        })));
    }

    let already_member: bool = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(&channel_id)
    .bind(&body.member_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if already_member {
        return Err(AppError::BadRequest(
            "user is already a channel member".into(),
        ));
    }

    let channel = sqlx::query("SELECT workspace_id, type FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let workspace_id: String = channel.try_get("workspace_id").unwrap_or_default();
    let channel_type: String = channel.try_get("type").unwrap_or_default();
    let workspace_status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&body.member_id)
    .fetch_optional(&state.db)
    .await?;

    if workspace_status.as_deref() != Some("active") && channel_type != "private" {
        return Err(AppError::Forbidden(
            "the user must accept the workspace before being invited to a public channel".into(),
        ));
    }
    if workspace_status.is_none() {
        let friends: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM friendships f
                WHERE f.status = 'accepted'
                  AND ((f.user_id = $1 AND f.friend_id = $2)
                    OR (f.user_id = $2 AND f.friend_id = $1))
             )",
        )
        .bind(&claims.sub)
        .bind(&body.member_id)
        .fetch_one(&state.db)
        .await?;
        if !friends {
            return Err(AppError::Forbidden(
                "a cross-workspace private-channel invite is limited to friends".into(),
            ));
        }
        crate::api::workspaces::ensure_workspace_admin(
            &state,
            &workspace_id,
            &claims.sub,
            &claims.role,
        )
        .await?;
    }

    let mut tx = state.db.begin().await?;
    let mut workspace_invite_created = false;
    if workspace_status.is_none() {
        workspace_invite_created = sqlx::query(
            "INSERT INTO workspace_memberships
                (workspace_id, user_id, role, status, invited_by, invited_at)
             VALUES ($1, $2, 'member', 'pending', $3, NOW())
             ON CONFLICT (workspace_id, user_id) DO NOTHING",
        )
        .bind(&workspace_id)
        .bind(&body.member_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
    }
    let inserted = sqlx::query(
        "INSERT INTO channel_invites (channel_id, user_id, role, invited_by, invited_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (channel_id, user_id) DO NOTHING",
    )
    .bind(&channel_id)
    .bind(&body.member_id)
    .bind(&role)
    .bind(&claims.sub)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;

    if workspace_invite_created {
        crate::api::notifications::deliver_notification_by_id(
            &state,
            &body.member_id,
            &format!("workspace:{workspace_id}"),
        )
        .await?;
    } else if inserted > 0 && workspace_status.as_deref() == Some("active") {
        crate::api::notifications::deliver_notification_by_id(
            &state,
            &body.member_id,
            &format!("channel:{channel_id}"),
        )
        .await?;
    }

    let status = if workspace_status.as_deref() == Some("active") {
        "pending"
    } else {
        "pending_workspace"
    };

    Ok(Json(json!({
        "channel_id": channel_id,
        "member_id": body.member_id,
        "member_type": "user",
        "role": role,
        "status": status,
    })))
}

/// POST /api/v1/channels/{channel_id}/accept — accept a pending channel invite:
/// consume the `channel_invites` row and materialize the real membership.
pub async fn accept_channel_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let mut tx = state.db.begin().await?;
    // Row-returning delete → 404 if there's no pending invite (or it was already answered).
    let invite = sqlx::query(
        "DELETE FROM channel_invites WHERE channel_id = $1 AND user_id = $2
         RETURNING role, invited_by",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .fetch_optional(&mut *tx)
    .await?;
    let (role, invited_by): (String, Option<String>) = match invite {
        Some(r) => (
            r.try_get("role").unwrap_or_else(|_| "member".into()),
            r.try_get::<Option<String>, _>("invited_by").ok().flatten(),
        ),
        None => return Err(AppError::NotFound),
    };
    // Workspace-first invariant re-checked at accept time: you may only JOIN a
    // channel if you are STILL an active member of its workspace. A user invited
    // while active, then removed from / having left the workspace before answering,
    // must not sneak in via a stale invite. We commit the DELETE anyway (consume the
    // now-invalid invite so it stops showing in their inbox) and then reject.
    let still_ws_member: bool = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships wm
            JOIN channels c ON c.workspace_id = wm.workspace_id
            WHERE c.channel_id = $1 AND wm.user_id = $2 AND wm.status = 'active'
        ) AS ok",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .fetch_one(&mut *tx)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if !still_ws_member {
        tx.commit().await?;
        crate::api::notifications::resolve_notification(
            &state,
            &claims.sub,
            &format!("channel:{channel_id}"),
        )
        .await;
        return Err(AppError::Forbidden(
            "you are no longer a member of this channel's workspace".into(),
        ));
    }
    let added_by = invited_by.unwrap_or_else(|| claims.sub.clone());
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, 'user', $3, $4)
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .bind(&role)
    .bind(&added_by)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // New member → refresh presence for everyone already in the channel.
    if let Ok(cid) = Uuid::parse_str(&channel_id) {
        crate::gateway::presence::broadcast_presence(&state, cid).await;
    }
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("channel:{channel_id}"),
    )
    .await;
    Ok(Json(
        json!({"channel_id": channel_id, "status": "active", "role": role}),
    ))
}

/// POST /api/v1/channels/{channel_id}/join — self-serve join for PUBLIC channels
/// (Slack model): any ACTIVE member of the channel's workspace may join without
/// waiting for an invite. Private channels and DMs keep the consent-based invite
/// path as the only way in. Idempotent — joining a channel you're already in is
/// a no-op success.
pub async fn join_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let channel = sqlx::query("SELECT type, workspace_id FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let channel_type: String = channel.try_get("type").unwrap_or_default();
    let workspace_id: String = channel.try_get("workspace_id").unwrap_or_default();
    if channel_type != "public" {
        return Err(AppError::Forbidden(
            "only public channels can be joined without an invite".into(),
        ));
    }
    // Workspace-first invariant: self-join is a workspace-member privilege, checked
    // at join time (mirrors accept_channel_invite's re-check).
    let ws_member: bool = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
        ) AS ok",
    )
    .bind(&workspace_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if !ws_member {
        return Err(AppError::Forbidden(
            "you must be an active member of this channel's workspace".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    // Self-join always starts at 'member'; an invite-carried role never applies here.
    let inserted = sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, 'user', 'member', $2)
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // A pending invite to this channel is now moot — consume it so it stops
    // showing in the invitee's inbox and the member list's pending section.
    sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND user_id = $2")
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("channel:{channel_id}"),
    )
    .await;

    // New member → refresh presence for everyone already in the channel.
    if inserted > 0 {
        if let Ok(cid) = Uuid::parse_str(&channel_id) {
            crate::gateway::presence::broadcast_presence(&state, cid).await;
        }
    }
    Ok(Json(json!({
        "channel_id": channel_id,
        "member_id": claims.sub,
        "member_type": "user",
        "role": "member",
        "status": "active",
    })))
}

/// POST /api/v1/channels/{channel_id}/decline — decline a pending channel invite.
pub async fn decline_channel_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND user_id = $2")
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("channel:{channel_id}"),
    )
    .await;
    Ok(Json(json!({"declined": true})))
}

/// Bot-owner approval for a pending bot channel invitation.
pub async fn accept_bot_channel_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query(
        "SELECT bci.role, bci.invited_by, bci.cwd, bci.additional_dirs,
                b.is_disabled
         FROM bot_channel_invites bci
         JOIN bot_accounts b ON b.bot_id = bci.bot_id
         WHERE bci.channel_id = $1 AND bci.bot_id = $2
           AND bci.owner_user_id = $3 AND b.created_by = $3",
    )
    .bind(&channel_id)
    .bind(&bot_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if row.try_get::<bool, _>("is_disabled").unwrap_or(false) {
        return Err(AppError::BadRequest("disabled bot cannot be added".into()));
    }
    let role: String = row.try_get("role").unwrap_or_else(|_| "member".into());
    let invited_by: String = row
        .try_get("invited_by")
        .unwrap_or_else(|_| claims.sub.clone());
    let cwd: Option<String> = row.try_get("cwd").ok().flatten();
    let dirs_value: Value = row.try_get("additional_dirs").unwrap_or_else(|_| json!([]));
    let additional_dirs: Vec<String> = dirs_value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let bot_uuid =
        Uuid::parse_str(&bot_id).map_err(|_| AppError::BadRequest("invalid bot id".into()))?;
    let invite_signature = (
        role.clone(),
        invited_by.clone(),
        cwd.clone(),
        dirs_value.clone(),
    );
    let (cwd, additional_dirs) = if cwd.is_some() || !additional_dirs.is_empty() {
        crate::api::workspace::validate_workspace_paths(&state, bot_uuid, cwd, additional_dirs)
            .await?
    } else {
        (None, Vec::new())
    };
    let provider_account_id =
        crate::domain::messages::resolve_provider_account_id_for_bot(&state.db, bot_uuid)
            .await
            .unwrap_or_else(|_| bot_id.clone());

    let mut tx = state.db.begin().await?;
    let locked = sqlx::query(
        "SELECT bci.role, bci.invited_by, bci.cwd, bci.additional_dirs,
                b.is_disabled
         FROM bot_channel_invites bci
         JOIN bot_accounts b ON b.bot_id = bci.bot_id
         WHERE bci.channel_id = $1 AND bci.bot_id = $2
           AND bci.owner_user_id = $3 AND b.created_by = $3
         FOR UPDATE OF bci, b",
    )
    .bind(&channel_id)
    .bind(&bot_id)
    .bind(&claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if locked.try_get::<bool, _>("is_disabled").unwrap_or(false) {
        return Err(AppError::BadRequest("disabled bot cannot be added".into()));
    }
    let locked_signature = (
        locked
            .try_get::<String, _>("role")
            .unwrap_or_else(|_| "member".into()),
        locked
            .try_get::<String, _>("invited_by")
            .unwrap_or_else(|_| claims.sub.clone()),
        locked.try_get::<Option<String>, _>("cwd").ok().flatten(),
        locked
            .try_get::<Value, _>("additional_dirs")
            .unwrap_or_else(|_| json!([])),
    );
    if locked_signature != invite_signature {
        return Err(AppError::Conflict(
            "bot invitation changed while it was being accepted; retry".into(),
        ));
    }

    bind_bot_to_channel_tx(
        &mut tx,
        &channel_id,
        &bot_id,
        &provider_account_id,
        &role,
        &invited_by,
        cwd,
        additional_dirs,
    )
    .await?;
    let deleted =
        sqlx::query("DELETE FROM bot_channel_invites WHERE channel_id = $1 AND bot_id = $2")
            .bind(&channel_id)
            .bind(&bot_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if deleted != 1 {
        return Err(AppError::Conflict(
            "bot invitation was already resolved".into(),
        ));
    }
    tx.commit().await?;
    if let Ok(cid) = Uuid::parse_str(&channel_id) {
        crate::gateway::presence::broadcast_presence(&state, cid).await;
    }
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("bot-channel:{channel_id}:{bot_id}"),
    )
    .await;
    Ok(Json(json!({
        "channel_id": channel_id,
        "member_id": bot_id,
        "member_type": "bot",
        "role": role,
        "status": "active",
    })))
}

pub async fn decline_bot_channel_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let deleted = sqlx::query(
        "DELETE FROM bot_channel_invites
         WHERE channel_id = $1 AND bot_id = $2 AND owner_user_id = $3",
    )
    .bind(&channel_id)
    .bind(&bot_id)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?
    .rows_affected();
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    crate::api::notifications::resolve_notification(
        &state,
        &claims.sub,
        &format!("bot-channel:{channel_id}:{bot_id}"),
    )
    .await;
    Ok(Json(json!({ "declined": true })))
}

#[cfg(test)]
#[allow(
    clippy::items_after_test_module,
    reason = "contract tests stay beside invite helpers while membership handlers continue below"
)]
mod tests {
    use super::*;

    #[test]
    fn dm_created_is_a_top_level_realtime_event() {
        let channel_id = Uuid::new_v4();
        let frame = dm_created_frame(channel_id);

        assert_eq!(frame.frame_type, "dm_created");
        assert_eq!(frame.data["channel_id"], channel_id.to_string());
    }

    #[test]
    fn platform_admin_can_request_owned_bot_approval_without_a_grant() {
        assert!(!bot_add_requires_session_create(false, false, true));
        assert!(bot_add_requires_session_create(false, false, false));
    }

    #[test]
    fn platform_admin_can_create_a_channel_without_workspace_membership() {
        assert!(can_create_channel(None, true));
        assert!(!can_create_channel(None, false));
        assert!(can_create_channel(Some("member"), false));
    }

    #[test]
    fn queued_channel_invite_keeps_workspace_pending_status() {
        assert_eq!(pending_channel_invite_status(Some("active")), "pending");
        assert_eq!(
            pending_channel_invite_status(Some("pending")),
            "pending_workspace"
        );
        assert_eq!(pending_channel_invite_status(None), "pending_workspace");
    }
}

/// Revoke a user's channel-scoped ACP approval authority when they leave / are
/// removed: their approver delegations (`approval_delegations`) and any per-user
/// RESPOND overrides (`bot_event_access`) for this channel. Parameterized;
/// harmless no-op when `user_id` is a bot (neither table holds bot user rows).
async fn purge_channel_approval_authority(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM approval_delegations WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "DELETE FROM bot_event_access
         WHERE channel_id = $1 AND subject_kind = 'user' AND subject_id = $2
        ",
    )
    .bind(channel_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn remove_channel_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, member_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let removing_last_owner: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships removing
            JOIN channels c ON c.channel_id = removing.channel_id
            WHERE removing.channel_id = $1 AND removing.member_id = $2
              AND removing.member_type = 'user' AND removing.role = 'owner'
              AND c.type <> 'dm' AND c.archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM channel_memberships other
                WHERE other.channel_id = removing.channel_id
                  AND other.member_type = 'user' AND other.role = 'owner'
                  AND other.member_id <> removing.member_id
              )
        )",
    )
    .bind(&channel_id)
    .bind(&member_id)
    .fetch_one(&state.db)
    .await?;
    if removing_last_owner {
        return Err(AppError::BadRequest(
            "transfer channel ownership or delete the channel first".into(),
        ));
    }
    let pending_user: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channel_invites WHERE channel_id = $1 AND user_id = $2)",
    )
    .bind(&channel_id)
    .bind(&member_id)
    .fetch_one(&state.db)
    .await?;
    let pending_bot_owner: Option<String> = sqlx::query_scalar(
        "SELECT owner_user_id FROM bot_channel_invites WHERE channel_id = $1 AND bot_id = $2",
    )
    .bind(&channel_id)
    .bind(&member_id)
    .fetch_optional(&state.db)
    .await?;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id = $1 AND member_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    // Also rescind a still-pending invite (removing = "not in this channel", whether
    // they'd accepted yet or not). Harmless no-op for active members / bots.
    sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND user_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM bot_channel_invites WHERE channel_id = $1 AND bot_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    if let Some(owner_id) = pending_bot_owner {
        crate::api::notifications::resolve_notification(
            &state,
            &owner_id,
            &format!("bot-channel:{channel_id}:{member_id}"),
        )
        .await;
    }
    if pending_user {
        crate::api::notifications::resolve_notification(
            &state,
            &member_id,
            &format!("channel:{channel_id}"),
        )
        .await;
    }
    // A removed member must not retain approval authority in this channel: drop any
    // approver delegations they held (approval_delegations) and any per-user RESPOND
    // overrides (bot_event_access) — otherwise a stale row would still let them
    // resolve this channel's ACP permission requests. No-op for bots.
    purge_channel_approval_authority(&state, &channel_id, &member_id).await?;
    if let Ok(cid) = Uuid::parse_str(&channel_id) {
        // Membership checks happen at subscribe time, so removal must cut any
        // LIVE subscriptions too — otherwise the removed member keeps receiving
        // every new message until their socket happens to close. (No-op for
        // bots: they have no browser connections.)
        if let Ok(uid) = Uuid::parse_str(&member_id) {
            state
                .conn_manager
                .revoke_channel_subscriptions(uid, cid)
                .await;
        }
        crate::gateway::presence::broadcast_presence(&state, cid).await;
    }
    Ok(Json(json!({"removed": true})))
}

/// Whether the caller may grant/revoke the OWNER rank in this channel: a global
/// admin, or a member whose own channel role is 'owner'. Plain channel 'admin's
/// can manage members but must NOT be able to mint owners (privilege escalation).
async fn caller_channel_is_owner(
    state: &AppState,
    channel_id: &str,
    claims: &Claims,
) -> Result<bool, AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(true);
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?;
    Ok(role.as_deref() == Some("owner"))
}

/// The caller's role in this channel (for the bot_event_policy role tier), or
/// `"member"` when not found / on a DB error — the acp_policy resolution is itself
/// fail-closed for owner-default events, so a downgraded role never over-grants.
async fn caller_channel_role(state: &AppState, channel_id: &str, user_id: &str) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "member".to_string())
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

    if role == "owner" {
        // Owner leaving reduces the owner count, so serialize against concurrent
        // owner leaves/demotes: lock the owner rows, re-count, delete, all in one tx.
        let mut tx = state.db.begin().await?;
        let owners = sqlx::query(
            "SELECT 1 FROM channel_memberships
             WHERE channel_id = $1 AND member_type = 'user' AND role = 'owner' FOR UPDATE",
        )
        .bind(&channel_id)
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
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
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    } else {
        sqlx::query(
            "DELETE FROM channel_memberships
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
        )
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    }
    // Same authority purge as remove_channel_member: a member who leaves must not
    // keep approver delegations or per-user RESPOND overrides in this channel.
    purge_channel_approval_authority(&state, &channel_id, &claims.sub).await?;
    // Same reverse edge as remove_channel_member: cut the leaver's live
    // subscriptions so they stop receiving new frames immediately.
    if let (Ok(cid), Ok(uid)) = (Uuid::parse_str(&channel_id), Uuid::parse_str(&claims.sub)) {
        state
            .conn_manager
            .revoke_channel_subscriptions(uid, cid)
            .await;
        crate::gateway::presence::broadcast_presence(&state, cid).await;
    }
    Ok(Json(json!({ "left": true })))
}

/// PATCH /api/v1/channels/{channel_id}/members/{member_id} — change a member's
/// role (admin-only)，用户与 bot 走同一入口。
/// 用户：owner 相关变更需 owner/全局管理员；拒绝把最后一个 owner 降级；不能改自己。
/// bot：只允许 member/readonly（bot 的 owner/admin 在 REST 权限层无意义，禁授）。
pub async fn set_channel_member_role(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, member_id)): Path<(String, String)>,
    Json(body): Json<MemberRoleRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if member_id == claims.sub {
        return Err(AppError::BadRequest(
            "use leave or transfer ownership to change your own role".into(),
        ));
    }
    let role = body.role;
    if !matches!(role.as_str(), "owner" | "admin" | "member" | "readonly") {
        return Err(AppError::BadRequest(
            "role must be owner, admin, member, or readonly".into(),
        ));
    }
    let row = sqlx::query(
        "SELECT role, member_type FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(&channel_id)
    .bind(&member_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let current: String = row.try_get("role").unwrap_or_else(|_| "member".into());
    let member_type: String = row.try_get("member_type").unwrap_or_else(|_| "user".into());

    if member_type == "bot" {
        if !matches!(role.as_str(), "member" | "readonly") {
            return Err(AppError::BadRequest(
                "a bot's channel role must be member or readonly".into(),
            ));
        }
        sqlx::query(
            "UPDATE channel_memberships SET role = $3
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'",
        )
        .bind(&channel_id)
        .bind(&member_id)
        .bind(&role)
        .execute(&state.db)
        .await?;
        return Ok(Json(json!({ "member_id": member_id, "role": role })));
    }

    // Privilege guard: granting 'owner' or modifying an existing owner requires the
    // caller to be an owner (or global admin) — a plain 'admin' can't mint/seize owner.
    if (role == "owner" || current == "owner")
        && !caller_channel_is_owner(&state, &channel_id, &claims).await?
    {
        return Err(AppError::Forbidden(
            "only an owner or a system admin can grant or change the owner role".into(),
        ));
    }

    if current == "owner" && role != "owner" {
        // Demoting an owner reduces the owner count — serialize like leave.
        let mut tx = state.db.begin().await?;
        let owners = sqlx::query(
            "SELECT 1 FROM channel_memberships
             WHERE channel_id = $1 AND member_type = 'user' AND role = 'owner' FOR UPDATE",
        )
        .bind(&channel_id)
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
            return Err(AppError::Forbidden(
                "can't demote the last owner — promote another owner first".into(),
            ));
        }
        sqlx::query(
            "UPDATE channel_memberships SET role = $3
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
        )
        .bind(&channel_id)
        .bind(&member_id)
        .bind(&role)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    } else {
        sqlx::query(
            "UPDATE channel_memberships SET role = $3
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
        )
        .bind(&channel_id)
        .bind(&member_id)
        .bind(&role)
        .execute(&state.db)
        .await?;
    }
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
