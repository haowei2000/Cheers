//! Shareable workspace invite links (Slack/Discord-style).
//!
//! A workspace admin mints a URL-embeddable bearer token; anyone holding the URL
//! may join the workspace as a plain 'member' while the link is live (not revoked,
//! not expired, use budget not exhausted). This complements the two consent-based
//! invite kinds — which require the admin to already know the invitee — and is the
//! entry path for people with NO account yet: `POST /auth/register` accepts a live
//! invite token in place of `config.open_registration` (see `token_is_live`).
//!
//! Trust model: possession of the token IS the authorization (like an enrollment
//! code), so the two token-keyed endpoints are public-facing and rate-limited;
//! everything else sits behind JWT + `ensure_workspace_admin`. A "use" is consumed
//! only when a NEW workspace membership is created — previews, re-clicks by
//! members, and accepting an existing directed invite through the link are free.

use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{
    api::middleware::Claims, api::workspaces::ensure_workspace_admin, app_state::AppState,
    errors::AppError,
};

/// Hard ceiling on live (non-revoked, non-expired, non-exhausted) links per
/// workspace — keeps the management list readable and bounds junk minting.
const MAX_LIVE_LINKS_PER_WORKSPACE: i64 = 20;
/// Longest allowed expiry: 1 year. `None` = never expires.
const MAX_EXPIRES_IN_HOURS: i64 = 24 * 365;
const MAX_MAX_USES: i32 = 1000;

#[derive(Deserialize)]
pub struct CreateInviteLinkRequest {
    /// Hours until the link expires; omit/null = never expires.
    pub expires_in_hours: Option<i64>,
    /// How many NEW members the link may admit; omit/null = unlimited.
    pub max_uses: Option<i32>,
    /// Scope the link to a PUBLIC channel of the workspace: joiners also land in
    /// that channel. Grants nothing a workspace member couldn't self-serve.
    pub channel_id: Option<String>,
}

#[derive(Serialize)]
pub struct InviteLinkDto {
    pub link_id: String,
    /// The bearer token — the client renders it as `<origin>/invite/<token>`.
    pub token: String,
    pub workspace_id: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    /// Creator display name (best-effort).
    pub created_by: Option<String>,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
    pub max_uses: Option<i32>,
    pub use_count: i32,
    /// "active" | "expired" | "exhausted" (revoked links are never listed).
    pub status: String,
}

fn row_to_dto(r: &sqlx::postgres::PgRow) -> InviteLinkDto {
    let expired: bool = r.try_get("expired").unwrap_or(false);
    let exhausted: bool = r.try_get("exhausted").unwrap_or(false);
    InviteLinkDto {
        link_id: r.try_get("link_id").unwrap_or_default(),
        token: r.try_get("token").unwrap_or_default(),
        workspace_id: r.try_get("workspace_id").unwrap_or_default(),
        channel_id: r.try_get("channel_id").ok().flatten(),
        channel_name: r.try_get("channel_name").ok().flatten(),
        created_by: r.try_get("created_by_name").ok().flatten(),
        created_at: r.try_get("created_at").ok().flatten(),
        expires_at: r.try_get("expires_at").ok().flatten(),
        max_uses: r.try_get("max_uses").ok().flatten(),
        use_count: r.try_get("use_count").unwrap_or(0),
        status: if expired {
            "expired".into()
        } else if exhausted {
            "exhausted".into()
        } else {
            "active".into()
        },
    }
}

/// Columns every link query selects — keep the projection in one place so
/// list/create stay in lockstep with `row_to_dto`.
const LINK_COLUMNS: &str = "il.link_id, il.token, il.workspace_id, il.channel_id,
        c.name AS channel_name,
        COALESCE(u.display_name, u.username) AS created_by_name,
        il.created_at::text AS created_at, il.expires_at::text AS expires_at,
        il.max_uses, il.use_count,
        (il.expires_at IS NOT NULL AND il.expires_at <= NOW()) AS expired,
        (il.max_uses IS NOT NULL AND il.use_count >= il.max_uses) AS exhausted";

/// POST /api/v1/workspaces/{workspace_id}/invite-links — mint a shareable link
/// (workspace admin). Returns the full record incl. the token; the token stays
/// re-readable via the list endpoint for the link's lifetime.
pub async fn create_invite_link(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
    Json(body): Json<CreateInviteLinkRequest>,
) -> Result<Json<InviteLinkDto>, AppError> {
    ensure_workspace_admin(&state, &workspace_id, &claims.sub, &claims.role).await?;

    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM workspaces WHERE workspace_id = $1")
            .bind(&workspace_id)
            .fetch_optional(&state.db)
            .await?;
    match kind.as_deref() {
        None => return Err(AppError::NotFound),
        Some("personal") => {
            return Err(AppError::BadRequest(
                "personal workspaces cannot have invite links".into(),
            ))
        }
        Some(_) => {}
    }

    if let Some(h) = body.expires_in_hours {
        if !(1..=MAX_EXPIRES_IN_HOURS).contains(&h) {
            return Err(AppError::BadRequest(format!(
                "expires_in_hours must be between 1 and {MAX_EXPIRES_IN_HOURS}"
            )));
        }
    }
    if let Some(n) = body.max_uses {
        if !(1..=MAX_MAX_USES).contains(&n) {
            return Err(AppError::BadRequest(format!(
                "max_uses must be between 1 and {MAX_MAX_USES}"
            )));
        }
    }

    // A channel-scoped link must point at a PUBLIC channel of THIS workspace:
    // joiners could self-join it anyway once inside, so the link adds convenience,
    // not privilege. Private channels/DMs keep consent-based invites as the only
    // way in — a bearer link must not become a back door.
    if let Some(cid) = body.channel_id.as_deref() {
        let ch = sqlx::query("SELECT workspace_id, type FROM channels WHERE channel_id = $1")
            .bind(cid)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
        let ch_ws: String = ch.try_get("workspace_id").unwrap_or_default();
        let ch_type: String = ch.try_get("type").unwrap_or_default();
        if ch_ws != workspace_id {
            return Err(AppError::BadRequest(
                "channel does not belong to this workspace".into(),
            ));
        }
        if ch_type != "public" {
            return Err(AppError::BadRequest(
                "invite links can only target public channels".into(),
            ));
        }
    }

    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invite_links
         WHERE workspace_id = $1 AND NOT revoked
           AND (expires_at IS NULL OR expires_at > NOW())
           AND (max_uses IS NULL OR use_count < max_uses)",
    )
    .bind(&workspace_id)
    .fetch_one(&state.db)
    .await?;
    if live >= MAX_LIVE_LINKS_PER_WORKSPACE {
        return Err(AppError::BadRequest(format!(
            "this workspace already has {MAX_LIVE_LINKS_PER_WORKSPACE} live invite links — revoke one first"
        )));
    }

    let link_id = Uuid::new_v4().to_string();
    let token = crate::infra::crypto::generate_invite_link_token();
    let expires_at = body
        .expires_in_hours
        .map(|h| chrono::Utc::now() + chrono::Duration::hours(h));
    sqlx::query(
        "INSERT INTO invite_links (link_id, token, workspace_id, channel_id, created_by, expires_at, max_uses)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&link_id)
    .bind(&token)
    .bind(&workspace_id)
    .bind(&body.channel_id)
    .bind(&claims.sub)
    .bind(expires_at)
    .bind(body.max_uses)
    .execute(&state.db)
    .await?;

    let row = sqlx::query(&format!(
        "SELECT {LINK_COLUMNS} FROM invite_links il
         LEFT JOIN channels c ON c.channel_id = il.channel_id
         LEFT JOIN users u ON u.user_id = il.created_by
         WHERE il.link_id = $1"
    ))
    .bind(&link_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row_to_dto(&row)))
}

/// GET /api/v1/workspaces/{workspace_id}/invite-links — every non-revoked link,
/// newest first (workspace admin). Expired/exhausted ones come back with their
/// status so the UI can show why a shared URL stopped working.
pub async fn list_invite_links(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<InviteLinkDto>>, AppError> {
    ensure_workspace_admin(&state, &workspace_id, &claims.sub, &claims.role).await?;
    let rows = sqlx::query(&format!(
        "SELECT {LINK_COLUMNS} FROM invite_links il
         LEFT JOIN channels c ON c.channel_id = il.channel_id
         LEFT JOIN users u ON u.user_id = il.created_by
         WHERE il.workspace_id = $1 AND NOT il.revoked
         ORDER BY il.created_at DESC"
    ))
    .bind(&workspace_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.iter().map(row_to_dto).collect()))
}

/// DELETE /api/v1/workspaces/{workspace_id}/invite-links/{link_id} — revoke
/// (workspace admin). The shared URL stops working immediately; idempotent.
pub async fn revoke_invite_link(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((workspace_id, link_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_workspace_admin(&state, &workspace_id, &claims.sub, &claims.role).await?;
    let res = sqlx::query(
        "UPDATE invite_links SET revoked = TRUE WHERE link_id = $1 AND workspace_id = $2",
    )
    .bind(&link_id)
    .bind(&workspace_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "revoked": true })))
}

#[derive(Serialize)]
pub struct InviteLinkPreviewDto {
    /// "valid" | "expired" | "exhausted". Revoked/unknown tokens 404 instead —
    /// a revoked link must be indistinguishable from one that never existed.
    pub status: String,
    /// Workspace details — present only while the link is valid (a dead link
    /// must not keep leaking what it pointed at).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    /// Display name of whoever minted the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inviter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<i64>,
}

/// GET /api/v1/invite-links/{token} — public link preview for the landing page
/// (no JWT: the visitor typically has no account yet). Never mutates; a "use" is
/// only consumed by accept/registration. Rate-limited per client since the token
/// space is probe-able in principle (128-bit random in practice).
pub async fn preview_invite_link(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<InviteLinkPreviewDto>, AppError> {
    let limiter = crate::infra::ratelimit::invite_link_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if !limiter.try_hit(&key) {
        return Err(AppError::TooManyRequests {
            retry_after_secs: 60,
        });
    }

    let row = sqlx::query(
        "SELECT il.workspace_id, il.channel_id, w.name AS workspace_name,
                w.avatar_url AS workspace_avatar_url, c.name AS channel_name,
                COALESCE(u.display_name, u.username) AS inviter,
                (il.expires_at IS NOT NULL AND il.expires_at <= NOW()) AS expired,
                (il.max_uses IS NOT NULL AND il.use_count >= il.max_uses) AS exhausted,
                (SELECT COUNT(*) FROM workspace_memberships wm
                  WHERE wm.workspace_id = il.workspace_id AND wm.status = 'active') AS member_count
         FROM invite_links il
         JOIN workspaces w ON w.workspace_id = il.workspace_id
         LEFT JOIN channels c ON c.channel_id = il.channel_id
         LEFT JOIN users u ON u.user_id = il.created_by
         WHERE il.token = $1 AND NOT il.revoked",
    )
    .bind(token.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let expired: bool = row.try_get("expired").unwrap_or(false);
    let exhausted: bool = row.try_get("exhausted").unwrap_or(false);
    if expired || exhausted {
        return Ok(Json(InviteLinkPreviewDto {
            status: if expired { "expired" } else { "exhausted" }.into(),
            workspace_id: None,
            workspace_name: None,
            workspace_avatar_url: None,
            channel_id: None,
            channel_name: None,
            inviter: None,
            member_count: None,
        }));
    }
    Ok(Json(InviteLinkPreviewDto {
        status: "valid".into(),
        workspace_id: row.try_get("workspace_id").ok(),
        workspace_name: row.try_get("workspace_name").ok(),
        workspace_avatar_url: row.try_get("workspace_avatar_url").ok().flatten(),
        channel_id: row.try_get("channel_id").ok().flatten(),
        channel_name: row.try_get("channel_name").ok().flatten(),
        inviter: row.try_get("inviter").ok().flatten(),
        member_count: row.try_get("member_count").ok(),
    }))
}

/// POST /api/v1/invite-links/{token}/accept — the authenticated caller redeems a
/// link. Outcomes: fresh workspace join (consumes a use), a pending directed
/// invite flips to active (free), or already-a-member no-op (free). All three
/// then best-effort-join the link's public channel, so a channel-scoped link is
/// useful to existing members too. New-user flow: /auth/register with the invite
/// token (auto-login) → this endpoint.
pub async fn accept_invite_link(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(token): Path<String>,
) -> Result<Json<Value>, AppError> {
    let link = sqlx::query(
        "SELECT il.link_id, il.workspace_id, il.channel_id, il.created_by,
                (il.expires_at IS NOT NULL AND il.expires_at <= NOW()) AS expired,
                (il.max_uses IS NOT NULL AND il.use_count >= il.max_uses) AS exhausted,
                w.kind
         FROM invite_links il
         JOIN workspaces w ON w.workspace_id = il.workspace_id
         WHERE il.token = $1 AND NOT il.revoked",
    )
    .bind(token.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let link_id: String = link.try_get("link_id").unwrap_or_default();
    let workspace_id: String = link.try_get("workspace_id").unwrap_or_default();
    let channel_id: Option<String> = link.try_get("channel_id").ok().flatten();
    let created_by: String = link.try_get("created_by").unwrap_or_default();
    let expired: bool = link.try_get("expired").unwrap_or(false);
    let exhausted: bool = link.try_get("exhausted").unwrap_or(false);
    if expired || exhausted {
        return Err(AppError::BadRequest(
            "this invite link is no longer valid".into(),
        ));
    }

    let me = claims.sub.clone();
    let membership: Option<String> = sqlx::query_scalar(
        "SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(&workspace_id)
    .bind(&me)
    .fetch_optional(&state.db)
    .await?;

    let already_member = match membership.as_deref() {
        Some("active") => true,
        Some(_) => {
            // A pending directed invite + clicking the link = the user consents.
            // The admin-side grant already exists, so no use is consumed.
            sqlx::query(
                "UPDATE workspace_memberships SET status = 'active'
                 WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'",
            )
            .bind(&workspace_id)
            .bind(&me)
            .execute(&state.db)
            .await?;
            false
        }
        None => {
            // Fresh join: creating the membership and reserving a use must be
            // atomic. Membership first — if it conflicts, a concurrent request
            // already admitted this user and no use is owed; otherwise the
            // conditional UPDATE is the gate against races on the last remaining
            // use (0 rows → budget/validity lost since the fetch → tx rolls the
            // membership back).
            let mut tx = state.db.begin().await?;
            let inserted = sqlx::query(
                "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by, invited_at)
                 VALUES ($1, $2, 'member', 'active', $3, NOW())
                 ON CONFLICT (workspace_id, user_id) DO NOTHING",
            )
            .bind(&workspace_id)
            .bind(&me)
            .bind(&created_by)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if inserted > 0 {
                let reserved = sqlx::query(
                    "UPDATE invite_links SET use_count = use_count + 1
                     WHERE link_id = $1 AND NOT revoked
                       AND (expires_at IS NULL OR expires_at > NOW())
                       AND (max_uses IS NULL OR use_count < max_uses)",
                )
                .bind(&link_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if reserved == 0 {
                    return Err(AppError::BadRequest(
                        "this invite link is no longer valid".into(),
                    ));
                }
            }
            tx.commit().await?;
            inserted == 0
        }
    };

    // Channel-scoped link: drop the joiner into the public channel. Re-validated
    // at redeem time — the channel may have been deleted or flipped private since
    // minting, and a bearer link must never bypass private-channel consent.
    let mut channel_joined = false;
    if let Some(cid) = channel_id.as_deref() {
        let ch_type: Option<String> =
            sqlx::query_scalar("SELECT type FROM channels WHERE channel_id = $1")
                .bind(cid)
                .fetch_optional(&state.db)
                .await?;
        if ch_type.as_deref() == Some("public") {
            let mut tx = state.db.begin().await?;
            let inserted = sqlx::query(
                "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
                 VALUES ($1, $2, 'user', 'member', $3)
                 ON CONFLICT (channel_id, member_id) DO NOTHING",
            )
            .bind(cid)
            .bind(&me)
            .bind(&created_by)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            // A pending directed invite to this channel is now moot (mirrors join_channel).
            sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND user_id = $2")
                .bind(cid)
                .bind(&me)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            channel_joined = true;
            if inserted > 0 {
                if let Ok(cid) = Uuid::parse_str(cid) {
                    crate::gateway::presence::broadcast_presence(&state, cid).await;
                }
            }
        }
    }

    Ok(Json(json!({
        "workspace_id": workspace_id,
        "channel_id": channel_id,
        "channel_joined": channel_joined,
        "already_member": already_member,
        "status": "active",
    })))
}

/// Whether `token` is currently redeemable (not revoked / expired / exhausted).
/// Used by the register flow: a live invite link substitutes for
/// `config.open_registration` — the link IS the sign-up authorization. Read-only;
/// the use is consumed later by `accept_invite_link` after the account exists.
pub async fn token_is_live(db: &sqlx::PgPool, token: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM invite_links
            WHERE token = $1 AND NOT revoked
              AND (expires_at IS NULL OR expires_at > NOW())
              AND (max_uses IS NULL OR use_count < max_uses)
        )",
    )
    .bind(token.trim())
    .fetch_one(db)
    .await
}
