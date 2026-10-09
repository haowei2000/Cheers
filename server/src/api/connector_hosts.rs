//! Connector host management for Agent Bridge connectors.
//!
//! A bot remains the durable channel identity. Each row here represents one
//! concrete connector host with its own revocable, rotatable bearer secret.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use uuid::Uuid;

use crate::{
    api::{
        bots::{ensure_bot_owner_or_admin, ensure_recent_bot_owner_or_admin},
        middleware::Claims,
    },
    app_state::AppState,
    domain::mcp_check,
    errors::AppError,
    infra::crypto::{generate_host_credential, hash_host_credential},
};

pub async fn list_hosts(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let bot_uuid = Uuid::parse_str(&bot_id).map_err(|_| AppError::NotFound)?;
    let bot_online = state.bot_locator.is_online(bot_uuid).await;
    // A revoked pending host never held a credential and is not a runtime
    // location — it is an abandoned pairing attempt, kept only until the reaper
    // clears it with its code (up to a day). Listing it as a device is noise, and
    // replacing a code in the setup wizard leaves one behind every time. The
    // management audit log keeps the trail.
    let rows = sqlx::query!(
        "SELECT host_id, device_name, agent_type, credential_prefix, status,
                connector_version, capabilities, last_seen_at, connected_at,
                credential_rotated_at, created_at, updated_at, revoked_at,
                mcp_connection_state, mcp_state_updated_at, mcp_connected_at,
                mcp_last_seen_at
         FROM connector_hosts
         WHERE bot_id = $1
           AND NOT (status = 'pending' AND revoked_at IS NOT NULL)
         ORDER BY created_at DESC",
        &bot_id,
    )
    .fetch_all(&state.db)
    .await?;

    let hosts = rows.into_iter().map(|row| {
        let status: String = row.status.clone();
        let revoked_at = row.revoked_at.clone();
        let agent_type = row.agent_type.clone();
        json!({
            "host_id": row.host_id.clone(),
            "device_name": row.device_name.clone(),
            "agent_type": agent_type,
            "agent_profile": crate::domain::agent_profile::profile(&agent_type),
            "credential_prefix": row.credential_prefix.clone().unwrap_or_default(),
            "status": status,
            "online": bot_online && status == "active" && revoked_at.is_none(),
            "connector_version": row.connector_version.clone(),
            "capabilities": row.capabilities.clone(),
            "last_seen_at": row.last_seen_at.clone(),
            "connected_at": row.connected_at.clone(),
            "credential_rotated_at": Some(row.credential_rotated_at.clone()),
            "created_at": Some(row.created_at.clone()),
            "updated_at": Some(row.updated_at.clone()),
            "revoked_at": revoked_at,
            "mcp_connection_state": if revoked_at.is_some() { "revoked".to_string() } else { row.mcp_connection_state.clone() },
            "mcp_state_updated_at": Some(row.mcp_state_updated_at.clone()),
            "mcp_connected_at": row.mcp_connected_at.clone(),
            "mcp_last_seen_at": row.mcp_last_seen_at.clone(),
        })
    }).collect::<Vec<_>>();
    Ok(Json(json!({ "bot_id": bot_id, "hosts": hosts })))
}

/// The three-layer Cheers MCP check for one host (see `domain::mcp_check`).
pub async fn check_host_mcp(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let bot_uuid = Uuid::parse_str(&bot_id).map_err(|_| AppError::NotFound)?;
    let row = sqlx::query!(
        "SELECT status, revoked_at, agent_type, connector_version, last_seen_at,
                mcp_connection_state, mcp_token_issued_at, mcp_connected_at,
                mcp_last_seen_at, mcp_protocol_version, mcp_client_name,
                mcp_client_version, mcp_rejected_at, mcp_rejection
         FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2",
        &host_id,
        &bot_id,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let status: String = row.status.clone();
    let revoked = row.revoked_at.clone().is_some();
    let online = !revoked && status == "active" && state.bot_locator.is_online(bot_uuid).await;
    let agent_type = row.agent_type.clone();
    let host = mcp_check::HostEvidence {
        revoked,
        online,
        connector_version: row.connector_version.clone(),
        last_seen_at: row.last_seen_at.clone(),
        agent: crate::domain::agent_profile::profile(&agent_type),
        mcp_state: if revoked {
            "revoked".into()
        } else {
            row.mcp_connection_state.clone()
        },
        mcp_token_issued_at: row.mcp_token_issued_at.clone(),
        mcp_connected_at: row.mcp_connected_at.clone(),
        mcp_last_seen_at: row.mcp_last_seen_at.clone(),
        mcp_protocol_version: row.mcp_protocol_version.clone(),
        mcp_client_name: row.mcp_client_name.clone(),
        mcp_client_version: row.mcp_client_version.clone(),
        mcp_rejected_at: row.mcp_rejected_at.clone(),
        mcp_rejection: row.mcp_rejection.clone(),
        status,
    };
    let resource_url = state.config.mcp_resource_url();
    let gateway = mcp_check::GatewayEvidence {
        public_url: state.config.mcp_public_url.as_deref(),
        resource_url: &resource_url,
        protocol_version: crate::api::mcp::MCP_PROTOCOL_VERSION,
        legacy_protocol_versions: &crate::api::mcp::MCP_LEGACY_PROTOCOL_VERSIONS,
    };
    let report = mcp_check::evaluate(&gateway, &host, chrono::Utc::now());
    Ok(Json(json!(report)))
}

pub async fn list_host_repositories(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let active: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 AS present FROM connector_hosts
          WHERE host_id = $1 AND bot_id = $2 AND status = 'active' AND revoked_at IS NULL) AS "value!" "#,
        &host_id,
        &bot_id,
    )
    .fetch_one(&state.db)
    .await?;
    if !active {
        return Err(AppError::BadRequest(
            "repository discovery requires the Bot's active Host".into(),
        ));
    }
    let bot_id = Uuid::parse_str(&bot_id).map_err(|_| AppError::NotFound)?;
    Ok(Json(
        crate::api::workspace::discover_bot_repositories(&state, bot_id).await?,
    ))
}

pub async fn activate_host(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_recent_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let mut tx = state.db.begin().await?;
    sqlx::Executor::execute(
        &mut *tx,
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
            &bot_id,
        ),
    )
    .await?;
    let exists: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 AS present FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2 AND revoked_at IS NULL
           AND status IN ('active', 'standby') AND credential_hash IS NOT NULL) AS "value!" "#,
        &host_id,
        &bot_id,
    )
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    sqlx::query!(
        "UPDATE connector_hosts SET status = 'standby', updated_at = NOW()
         WHERE bot_id = $1 AND status = 'active' AND revoked_at IS NULL",
        &bot_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE connector_hosts SET status = 'active', updated_at = NOW()
         WHERE host_id = $1 AND bot_id = $2 AND revoked_at IS NULL",
        &host_id,
        &bot_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    kick_bot(&state, &bot_id);
    crate::domain::bot_management_audit::record(
        &state.db,
        "host.activated",
        Some(&bot_id),
        Some(&host_id),
        Some(&claims.sub),
        json!({}),
    )
    .await;
    tracing::info!(%bot_id, %host_id, owner = %claims.sub, "connector host activated");
    Ok(Json(
        json!({"bot_id": bot_id, "host_id": host_id, "status": "active"}),
    ))
}

pub async fn rotate_host_credential(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_recent_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let credential = generate_host_credential();
    let hash = hash_host_credential(&credential);
    let prefix = credential[..credential.len().min(13)].to_string();
    let row = sqlx::query!(
        "UPDATE connector_hosts
         SET credential_hash = $1, credential_prefix = $2,
             credential_rotated_at = NOW(), updated_at = NOW(),
             mcp_connection_state = 'unconfigured', mcp_state_updated_at = NOW(),
             mcp_connected_at = NULL, mcp_last_seen_at = NULL,
             mcp_token_issued_at = NULL, mcp_protocol_version = NULL,
             mcp_client_name = NULL, mcp_client_version = NULL,
             mcp_rejected_at = NULL, mcp_rejection = NULL
         WHERE host_id = $3 AND bot_id = $4 AND revoked_at IS NULL
           AND status IN ('active', 'standby') AND credential_hash IS NOT NULL
         RETURNING status",
        hash,
        &prefix,
        &host_id,
        &bot_id,
    )
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound);
    };
    if Some(row.status.clone()).as_deref() == Some("active") {
        kick_bot(&state, &bot_id);
    }
    crate::domain::bot_management_audit::record(
        &state.db,
        "host.credential_rotated",
        Some(&bot_id),
        Some(&host_id),
        Some(&claims.sub),
        json!({ "credential_prefix": prefix }),
    )
    .await;
    tracing::info!(%bot_id, %host_id, credential_prefix = %prefix, owner = %claims.sub, "connector host credential rotated");
    Ok(Json(json!({
        "bot_id": bot_id,
        "host_id": host_id,
        "credential": credential,
        "credential_prefix": prefix,
        "note": "Store this credential now. It is shown once and replaces only this host's previous credential."
    })))
}

pub async fn reconnect_host(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let active: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 AS present FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2
           AND status = 'active' AND revoked_at IS NULL) AS "value!" "#,
        &host_id,
        &bot_id,
    )
    .fetch_one(&state.db)
    .await?;
    if !active {
        return Err(AppError::BadRequest(
            "only the active host can be reconnected".into(),
        ));
    }
    kick_bot(&state, &bot_id);
    crate::domain::bot_management_audit::record(
        &state.db,
        "host.reconnect_requested",
        Some(&bot_id),
        Some(&host_id),
        Some(&claims.sub),
        json!({}),
    )
    .await;
    tracing::info!(%bot_id, %host_id, owner = %claims.sub, "connector host reconnect requested");
    Ok(Json(json!({
        "bot_id": bot_id,
        "host_id": host_id,
        "reconnect_requested": true
    })))
}

pub async fn revoke_host(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let mut tx = state.db.begin().await?;
    let previous_status = sqlx::query_scalar!(
        "SELECT status FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2 FOR UPDATE",
        &host_id,
        &bot_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(previous_status) = previous_status else {
        return Err(AppError::NotFound);
    };
    if previous_status == "pending" {
        sqlx::query!(
            "UPDATE enrollment_codes SET revoked = TRUE
             WHERE host_id = $1 AND bot_id = $2
               AND redeemed_at IS NULL AND NOT revoked",
            &host_id,
            &bot_id,
        )
        .execute(&mut *tx)
        .await?;
    }
    let revoked_status = status_after_revoke(&previous_status);
    sqlx::query!(
        "UPDATE connector_hosts
         SET revoked_at = COALESCE(revoked_at, NOW()), status = $3,
             mcp_connection_state = 'revoked', mcp_state_updated_at = NOW(), updated_at = NOW()
         WHERE host_id = $1 AND bot_id = $2",
        &host_id,
        &bot_id,
        revoked_status,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if previous_status == "active" {
        kick_bot(&state, &bot_id);
    }
    crate::domain::bot_management_audit::record(
        &state.db,
        "host.revoked",
        Some(&bot_id),
        Some(&host_id),
        Some(&claims.sub),
        json!({ "previous_status": previous_status }),
    )
    .await;
    tracing::info!(%bot_id, %host_id, owner = %claims.sub, "connector host revoked");
    Ok(Json(
        json!({"bot_id": bot_id, "host_id": host_id, "revoked": true}),
    ))
}

pub async fn delete_host_record(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let mut tx = state.db.begin().await?;

    let revoked_at: Option<Option<chrono::DateTime<chrono::Utc>>> = sqlx::query_scalar!(
        "SELECT revoked_at FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2
         FOR UPDATE",
        &host_id,
        &bot_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    match revoked_at {
        None => return Err(AppError::NotFound),
        Some(None) => {
            return Err(AppError::BadRequest(
                "revoke the host before deleting its record".into(),
            ));
        }
        Some(Some(_)) => {}
    }

    sqlx::query!(
        "DELETE FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2",
        &host_id,
        &bot_id,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    crate::domain::bot_management_audit::record(
        &state.db,
        "host.deleted",
        Some(&bot_id),
        Some(&host_id),
        Some(&claims.sub),
        json!({}),
    )
    .await;

    tracing::info!(
        %bot_id,
        %host_id,
        owner = %claims.sub,
        "connector host record deleted"
    );

    Ok(Json(json!({
        "bot_id": bot_id,
        "host_id": host_id,
        "deleted": true
    })))
}
/// A revoked pending Host stays pending until `pairing_reaper` removes
/// it with its revoked code. Credentialed Hosts become standby so the
/// historical row remains visible as a non-active runtime location.
fn status_after_revoke(previous_status: &str) -> &'static str {
    if previous_status == "pending" {
        "pending"
    } else {
        "standby"
    }
}

fn kick_bot(state: &AppState, bot_id: &str) {
    if let Ok(id) = Uuid::parse_str(bot_id) {
        state.bot_registry.kick(id);
    }
}

#[cfg(test)]
mod tests {
    use super::status_after_revoke;

    #[test]
    fn pending_revoke_remains_reapable() {
        assert_eq!(status_after_revoke("pending"), "pending");
        assert_eq!(status_after_revoke("active"), "standby");
        assert_eq!(status_after_revoke("standby"), "standby");
    }
}
