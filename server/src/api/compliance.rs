//! App Store compliance surfaces: self-service account deletion, user reports,
//! blocking-adjacent moderation, and explicit external-agent data consent.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::{apple_auth, middleware::Claims},
    app_state::AppState,
    errors::AppError,
    infra::crypto,
};

#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    pub confirmation: String,
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub apple: Option<apple_auth::AppleAuthorizationRequest>,
}

pub async fn delete_account(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<DeleteAccountRequest>,
) -> Result<Json<Value>, AppError> {
    if body.confirmation != "DELETE" {
        return Err(AppError::BadRequest(
            "type DELETE to confirm account deletion".into(),
        ));
    }
    let row =
        sqlx::query("SELECT password_hash FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(&claims.sub)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    let password_hash: Option<String> = row.try_get("password_hash")?;
    match (password_hash, body.current_password, body.apple) {
        (Some(hash), Some(password), _) => {
            if !crypto::verify_password(password, hash)
                .await
                .unwrap_or(false)
            {
                return Err(AppError::Unauthorized(
                    "current password is incorrect".into(),
                ));
            }
        }
        (_, _, Some(apple)) => {
            apple_auth::verify_recent_for_user(&state, &claims.sub, &apple).await?
        }
        (None, _, None) => {
            return Err(AppError::Unauthorized(
                "fresh Apple authentication is required".into(),
            ))
        }
        _ => {
            return Err(AppError::Unauthorized(
                "current password is required".into(),
            ))
        }
    }

    // Revoke first. If Apple is temporarily unavailable, do not pretend the
    // identity was deleted while a working refresh token remains at Apple.
    apple_auth::revoke_for_user(&state, &claims.sub).await?;
    delete_user_data(&state, &claims.sub).await?;
    Ok(Json(json!({"deleted": true})))
}

pub(crate) async fn delete_user_data(state: &AppState, user_id: &str) -> Result<(), AppError> {
    let mut tx = state.db.begin().await?;

    // Transfer each owned workspace to the oldest active admin/member. If there
    // is nobody to receive it, archive it instead of leaving an active orphan.
    let workspaces = sqlx::query(
        "SELECT workspace_id FROM workspace_memberships WHERE user_id = $1 AND role = 'owner' AND status = 'active'",
    ).bind(user_id).fetch_all(&mut *tx).await?;
    for row in workspaces {
        let workspace_id: String = row.try_get("workspace_id")?;
        let successor = sqlx::query(
            "SELECT user_id FROM workspace_memberships
             WHERE workspace_id = $1 AND user_id <> $2 AND status = 'active'
             ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, joined_at LIMIT 1",
        ).bind(&workspace_id).bind(user_id).fetch_optional(&mut *tx).await?;
        if let Some(successor) = successor {
            let successor_id: String = successor.try_get("user_id")?;
            sqlx::query("UPDATE workspace_memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2")
                .bind(&workspace_id).bind(successor_id).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE workspaces SET archived_at = NOW() WHERE workspace_id = $1")
                .bind(&workspace_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE channels SET archived_at = NOW() WHERE workspace_id = $1")
                .bind(&workspace_id)
                .execute(&mut *tx)
                .await?;
        }
    }

    let channels = sqlx::query(
        "SELECT channel_id FROM channel_memberships WHERE member_id = $1 AND member_type = 'user' AND role = 'owner'",
    ).bind(user_id).fetch_all(&mut *tx).await?;
    for row in channels {
        let channel_id: String = row.try_get("channel_id")?;
        let successor = sqlx::query(
            "SELECT member_id FROM channel_memberships
             WHERE channel_id = $1 AND member_id <> $2 AND member_type = 'user'
             ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, joined_at LIMIT 1",
        ).bind(&channel_id).bind(user_id).fetch_optional(&mut *tx).await?;
        if let Some(successor) = successor {
            let successor_id: String = successor.try_get("member_id")?;
            sqlx::query("UPDATE channel_memberships SET role = 'owner' WHERE channel_id = $1 AND member_id = $2")
                .bind(&channel_id).bind(successor_id).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE channels SET archived_at = NOW() WHERE channel_id = $1")
                .bind(&channel_id)
                .execute(&mut *tx)
                .await?;
        }
    }

    sqlx::query(
        "UPDATE bot_accounts SET is_disabled = TRUE, status = 'disabled' WHERE created_by = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM approval_delegations WHERE user_id = $1 OR granted_by = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM bot_event_access WHERE subject_kind = 'user' AND subject_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM ai_data_consents WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_devices WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM friendships WHERE user_id = $1 OR friend_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channel_invites WHERE user_id = $1 OR invited_by = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM auth_external_identities WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channel_memberships WHERE member_id = $1 AND member_type = 'user'")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM workspace_memberships WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    let deleted_username = format!("deleted_{}", user_id.replace('-', ""));
    sqlx::query(
        "UPDATE users SET username = $2, email = NULL, password_hash = NULL,
         display_name = 'Deleted User', bio = NULL, avatar_url = NULL,
         is_deleted = TRUE, deleted_at = NOW(), token_version = token_version + 1
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .bind(deleted_username)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Ok(user_uuid) = user_id.parse::<Uuid>() {
        state.fanout.kick_user(user_uuid);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SetPasswordRequest {
    pub new_password: String,
    pub apple: apple_auth::AppleAuthorizationRequest,
}

pub async fn set_password(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<SetPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    if body.new_password.chars().count() < crypto::MIN_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "password must be at least {} characters",
            crypto::MIN_PASSWORD_CHARS
        )));
    }
    apple_auth::verify_recent_for_user(&state, &claims.sub, &body.apple).await?;
    let hash = crypto::hash_password(body.new_password)
        .await
        .map_err(|e| AppError::Internal(format!("hash password: {e}")))?;
    sqlx::query("UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE user_id = $1 AND password_hash IS NULL")
        .bind(&claims.sub).bind(hash).execute(&state.db).await?;
    Ok(Json(json!({"password_set": true})))
}

#[derive(Deserialize)]
pub struct CreateReportRequest {
    pub target_type: String,
    pub target_id: String,
    pub channel_id: Option<String>,
    pub reason: String,
    pub details: Option<String>,
}

pub async fn create_report(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateReportRequest>,
) -> Result<Json<Value>, AppError> {
    if body
        .details
        .as_deref()
        .map(str::chars)
        .map(Iterator::count)
        .unwrap_or(0)
        > 4_000
    {
        return Err(AppError::BadRequest(
            "report details must be 4000 characters or fewer".into(),
        ));
    }
    if !matches!(
        body.reason.as_str(),
        "harassment" | "spam" | "illegal" | "privacy" | "other"
    ) {
        return Err(AppError::BadRequest("invalid report reason".into()));
    }
    let channel_id = if body.target_type == "message" {
        let row =
            sqlx::query("SELECT channel_id FROM messages WHERE msg_id = $1 AND is_deleted = FALSE")
                .bind(&body.target_id)
                .fetch_optional(&state.db)
                .await?
                .ok_or(AppError::NotFound)?;
        Some(row.try_get::<String, _>("channel_id")?)
    } else if body.target_type == "user" {
        if body.target_id == claims.sub {
            return Err(AppError::BadRequest("cannot report yourself".into()));
        }
        let channel_id = body.channel_id.clone().ok_or_else(|| {
            AppError::BadRequest("channel_id is required for a user report".into())
        })?;
        let target_visible = sqlx::query(
            "SELECT 1 FROM channel_memberships
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
        )
        .bind(&channel_id)
        .bind(&body.target_id)
        .fetch_optional(&state.db)
        .await?
        .is_some();
        if !target_visible {
            return Err(AppError::NotFound);
        }
        Some(channel_id)
    } else {
        return Err(AppError::BadRequest(
            "target_type must be message or user".into(),
        ));
    };
    if let Some(channel_id) = channel_id.as_deref() {
        let member = sqlx::query("SELECT 1 FROM channel_memberships WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'")
            .bind(channel_id).bind(&claims.sub).fetch_optional(&state.db).await?.is_some();
        if !member {
            return Err(AppError::Forbidden(
                "report target is not visible to you".into(),
            ));
        }
    }
    let report_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO content_reports (report_id, reporter_id, target_type, target_id, channel_id, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ).bind(&report_id).bind(&claims.sub).bind(&body.target_type).bind(&body.target_id)
        .bind(channel_id).bind(&body.reason).bind(body.details.as_deref().map(str::trim).filter(|v| !v.is_empty()))
        .execute(&state.db).await?;
    Ok(Json(json!({"report_id": report_id, "status": "open"})))
}

pub async fn list_reports(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    ensure_admin(&claims)?;
    let rows = sqlx::query(
        "SELECT report_id, reporter_id, target_type, target_id, channel_id, reason, details, status, resolution, created_at, resolved_at
         FROM content_reports ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, created_at DESC LIMIT 200",
    ).fetch_all(&state.db).await?;
    Ok(Json(Value::Array(rows.into_iter().map(|r| json!({
        "report_id": r.try_get::<String,_>("report_id").unwrap_or_default(),
        "reporter_id": r.try_get::<String,_>("reporter_id").unwrap_or_default(),
        "target_type": r.try_get::<String,_>("target_type").unwrap_or_default(),
        "target_id": r.try_get::<String,_>("target_id").unwrap_or_default(),
        "channel_id": r.try_get::<Option<String>,_>("channel_id").ok().flatten(),
        "reason": r.try_get::<String,_>("reason").unwrap_or_default(),
        "details": r.try_get::<Option<String>,_>("details").ok().flatten(),
        "status": r.try_get::<String,_>("status").unwrap_or_default(),
        "resolution": r.try_get::<Option<String>,_>("resolution").ok().flatten(),
        "created_at": r.try_get::<chrono::DateTime<chrono::Utc>,_>("created_at").ok(),
        "resolved_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>("resolved_at").ok().flatten(),
    })).collect())))
}

#[derive(Deserialize)]
pub struct UpdateReportRequest {
    pub status: String,
    pub resolution: Option<String>,
}

pub async fn update_report(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(report_id): Path<String>,
    Json(body): Json<UpdateReportRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_admin(&claims)?;
    if !matches!(body.status.as_str(), "reviewing" | "resolved" | "dismissed") {
        return Err(AppError::BadRequest("invalid report status".into()));
    }
    let resolved = matches!(body.status.as_str(), "resolved" | "dismissed");
    let result = sqlx::query(
        "UPDATE content_reports SET status = $2, resolution = $3,
         resolved_by = CASE WHEN $4 THEN $5 ELSE NULL END,
         resolved_at = CASE WHEN $4 THEN NOW() ELSE NULL END WHERE report_id = $1",
    )
    .bind(&report_id)
    .bind(&body.status)
    .bind(&body.resolution)
    .bind(resolved)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({"report_id": report_id, "status": body.status})))
}

fn ensure_admin(claims: &Claims) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "admin" | "system_admin") {
        Ok(())
    } else {
        Err(AppError::Forbidden("admin only".into()))
    }
}

pub async fn disclosures(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, &channel_id, &claims.sub).await?;
    let rows = sqlx::query(
        "SELECT b.bot_id, COALESCE(b.display_name, b.username) AS bot_name, b.processor_name,
                b.processor_privacy_url, b.processor_data_use, b.processor_policy_version,
                EXISTS(SELECT 1 FROM ai_data_consents c WHERE c.user_id = $2 AND c.channel_id = $1
                       AND c.bot_id = b.bot_id AND c.policy_version = b.processor_policy_version AND c.revoked_at IS NULL) AS consented
         FROM channel_memberships m JOIN bot_accounts b ON b.bot_id = m.member_id
         WHERE m.channel_id = $1 AND m.member_type = 'bot' AND b.external_processor = TRUE",
    ).bind(&channel_id).bind(&claims.sub).fetch_all(&state.db).await?;
    Ok(Json(Value::Array(rows.into_iter().map(|r| json!({
        "bot_id": r.try_get::<String,_>("bot_id").unwrap_or_default(),
        "bot_name": r.try_get::<String,_>("bot_name").unwrap_or_default(),
        "provider_name": r.try_get::<Option<String>,_>("processor_name").ok().flatten(),
        "privacy_url": r.try_get::<Option<String>,_>("processor_privacy_url").ok().flatten(),
        "data_use": r.try_get::<Option<String>,_>("processor_data_use").ok().flatten(),
        "policy_version": r.try_get::<String,_>("processor_policy_version").unwrap_or_else(|_| "1".into()),
        "consented": r.try_get::<bool,_>("consented").unwrap_or(false),
    })).collect())))
}

pub async fn my_consents(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        "SELECT c.channel_id, ch.name AS channel_name, b.bot_id,
                COALESCE(b.display_name,b.username) AS bot_name, b.processor_name,
                b.processor_privacy_url, b.processor_data_use, c.policy_version
         FROM ai_data_consents c
         JOIN channels ch ON ch.channel_id = c.channel_id
         JOIN bot_accounts b ON b.bot_id = c.bot_id
         WHERE c.user_id = $1 AND c.revoked_at IS NULL ORDER BY ch.name, bot_name",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(Value::Array(rows.into_iter().map(|r| json!({
        "channel_id": r.try_get::<String,_>("channel_id").unwrap_or_default(),
        "channel_name": r.try_get::<String,_>("channel_name").unwrap_or_default(),
        "bot_id": r.try_get::<String,_>("bot_id").unwrap_or_default(),
        "bot_name": r.try_get::<String,_>("bot_name").unwrap_or_default(),
        "provider_name": r.try_get::<Option<String>,_>("processor_name").ok().flatten(),
        "privacy_url": r.try_get::<Option<String>,_>("processor_privacy_url").ok().flatten(),
        "data_use": r.try_get::<Option<String>,_>("processor_data_use").ok().flatten(),
        "policy_version": r.try_get::<String,_>("policy_version").unwrap_or_default(),
    })).collect())))
}

#[derive(Deserialize)]
pub struct ConsentRequest {
    pub policy_version: String,
}

pub async fn grant_consent(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(String, String)>,
    Json(body): Json<ConsentRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, &channel_id, &claims.sub).await?;
    let current: String = sqlx::query(
        "SELECT b.processor_policy_version FROM channel_memberships m JOIN bot_accounts b ON b.bot_id = m.member_id
         WHERE m.channel_id = $1 AND m.member_id = $2 AND m.member_type = 'bot' AND b.external_processor = TRUE",
    ).bind(&channel_id).bind(&bot_id).fetch_optional(&state.db).await?
        .and_then(|r| r.try_get("processor_policy_version").ok()).ok_or(AppError::NotFound)?;
    if current != body.policy_version {
        return Err(AppError::Conflict(
            "AI disclosure changed; review the latest version".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO ai_data_consents (user_id, channel_id, bot_id, policy_version) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, channel_id, bot_id, policy_version) DO UPDATE SET granted_at = NOW(), revoked_at = NULL",
    ).bind(&claims.sub).bind(&channel_id).bind(&bot_id).bind(&current).execute(&state.db).await?;
    Ok(Json(json!({"consented": true, "policy_version": current})))
}

pub async fn revoke_consent(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, &channel_id, &claims.sub).await?;
    sqlx::query("UPDATE ai_data_consents SET revoked_at = NOW() WHERE user_id = $1 AND channel_id = $2 AND bot_id = $3 AND revoked_at IS NULL")
        .bind(&claims.sub).bind(&channel_id).bind(&bot_id).execute(&state.db).await?;
    Ok(Json(json!({"consented": false})))
}

async fn ensure_channel_member(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    let exists = sqlx::query("SELECT 1 FROM channel_memberships WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'")
        .bind(channel_id).bind(user_id).fetch_optional(&state.db).await?.is_some();
    if exists {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}

/// Fail closed only for external bots this message will actually trigger. Human
/// chat remains available when consent is declined.
pub async fn ensure_message_consents(
    state: &AppState,
    user_id: &str,
    channel_id: Uuid,
    mention_ids: &[Uuid],
    mention_names: &[String],
    session_id: Option<Uuid>,
) -> Result<(), AppError> {
    let session_bot_id = if let Some(session_id) = session_id {
        sqlx::query("SELECT bot_id FROM cheers_sessions WHERE session_id = $1")
            .bind(session_id.to_string())
            .fetch_optional(&state.db)
            .await?
            .and_then(|row| row.try_get::<String, _>("bot_id").ok())
    } else {
        None
    };
    let routes_all_bots =
        mention_names.iter().any(|n| {
            matches!(
                n.trim_start_matches('@').to_ascii_lowercase().as_str(),
                "all" | "bots"
            )
        }) || sqlx::query("SELECT auto_assist FROM channels WHERE channel_id = $1")
            .bind(channel_id.to_string())
            .fetch_optional(&state.db)
            .await?
            .and_then(|r| r.try_get::<bool, _>("auto_assist").ok())
            .unwrap_or(false);
    let rows = sqlx::query(
        "SELECT b.bot_id, COALESCE(b.display_name,b.username) AS bot_name, b.processor_name,
                b.processor_privacy_url, b.processor_data_use, b.processor_policy_version
         FROM channel_memberships m JOIN bot_accounts b ON b.bot_id = m.member_id
         WHERE m.channel_id = $1 AND m.member_type = 'bot' AND b.external_processor = TRUE",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await?;
    let mut missing = Vec::new();
    for row in rows {
        let bot_id: String = row.try_get("bot_id")?;
        let targeted = routes_all_bots
            || mention_ids.iter().any(|id| id.to_string() == bot_id)
            || session_bot_id.as_deref() == Some(bot_id.as_str());
        if !targeted {
            continue;
        }
        let version: String = row
            .try_get("processor_policy_version")
            .unwrap_or_else(|_| "1".into());
        let consented = sqlx::query(
            "SELECT 1 FROM ai_data_consents WHERE user_id=$1 AND channel_id=$2 AND bot_id=$3 AND policy_version=$4 AND revoked_at IS NULL",
        ).bind(user_id).bind(channel_id.to_string()).bind(&bot_id).bind(&version)
            .fetch_optional(&state.db).await?.is_some();
        if !consented {
            missing.push(json!({
            "bot_id": bot_id,
            "bot_name": row.try_get::<String,_>("bot_name").unwrap_or_default(),
            "provider_name": row.try_get::<Option<String>,_>("processor_name").ok().flatten(),
            "privacy_url": row.try_get::<Option<String>,_>("processor_privacy_url").ok().flatten(),
            "data_use": row.try_get::<Option<String>,_>("processor_data_use").ok().flatten(),
            "policy_version": version
        }));
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(AppError::PreconditionRequired(
            json!({"code":"ai_consent_required","disclosures":missing}).to_string(),
        ))
    }
}
