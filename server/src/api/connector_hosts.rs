//! Connector host management for Agent Bridge connectors.
//!
//! A bot remains the durable channel identity. Each row here represents one
//! concrete connector host with its own revocable, rotatable bearer secret.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::{
        bots::{ensure_bot_owner_or_admin, ensure_recent_bot_owner_or_admin},
        middleware::Claims,
    },
    app_state::AppState,
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
    let rows = sqlx::query(
        "SELECT host_id, device_name, agent_type, credential_prefix, status,
                connector_version, capabilities, last_seen_at, connected_at,
                credential_rotated_at, created_at, updated_at, revoked_at,
                mcp_connection_state, mcp_state_updated_at, mcp_connected_at,
                mcp_last_seen_at
         FROM connector_hosts
         WHERE bot_id = $1
           AND NOT (status = 'pending' AND revoked_at IS NOT NULL)
         ORDER BY created_at DESC",
    )
    .bind(&bot_id)
    .fetch_all(&state.db)
    .await?;

    let hosts = rows.into_iter().map(|row| {
        let status: String = row.try_get("status").unwrap_or_else(|_| "standby".into());
        let revoked_at = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at").ok().flatten();
        let agent_type = row.try_get::<String, _>("agent_type").unwrap_or_else(|_| "generic".into());
        json!({
            "host_id": row.try_get::<String, _>("host_id").unwrap_or_default(),
            "device_name": row.try_get::<String, _>("device_name").unwrap_or_default(),
            "agent_type": agent_type,
            "agent_profile": crate::domain::agent_profile::profile(&agent_type),
            "credential_prefix": row.try_get::<String, _>("credential_prefix").unwrap_or_default(),
            "status": status,
            "online": bot_online && status == "active" && revoked_at.is_none(),
            "connector_version": row.try_get::<Option<String>, _>("connector_version").ok().flatten(),
            "capabilities": row.try_get::<Option<Value>, _>("capabilities").ok().flatten(),
            "last_seen_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_seen_at").ok().flatten(),
            "connected_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("connected_at").ok().flatten(),
            "credential_rotated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("credential_rotated_at").ok(),
            "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            "revoked_at": revoked_at,
            "mcp_connection_state": if revoked_at.is_some() { "revoked".to_string() } else { row.try_get::<String, _>("mcp_connection_state").unwrap_or_else(|_| "unconfigured".into()) },
            "mcp_state_updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("mcp_state_updated_at").ok(),
            "mcp_connected_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("mcp_connected_at").ok().flatten(),
            "mcp_last_seen_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("mcp_last_seen_at").ok().flatten(),
        })
    }).collect::<Vec<_>>();
    Ok(Json(json!({ "bot_id": bot_id, "hosts": hosts })))
}

pub async fn list_host_repositories(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, host_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM connector_hosts
          WHERE host_id = $1 AND bot_id = $2 AND status = 'active' AND revoked_at IS NULL)",
    )
    .bind(&host_id)
    .bind(&bot_id)
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
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(&bot_id)
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2 AND revoked_at IS NULL
           AND status IN ('active', 'standby') AND credential_hash IS NOT NULL)",
    )
    .bind(&host_id)
    .bind(&bot_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    sqlx::query(
        "UPDATE connector_hosts SET status = 'standby', updated_at = NOW()
         WHERE bot_id = $1 AND status = 'active' AND revoked_at IS NULL",
    )
    .bind(&bot_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE connector_hosts SET status = 'active', updated_at = NOW()
         WHERE host_id = $1 AND bot_id = $2 AND revoked_at IS NULL",
    )
    .bind(&host_id)
    .bind(&bot_id)
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
    let row = sqlx::query(
        "UPDATE connector_hosts
         SET credential_hash = $1, credential_prefix = $2,
             credential_rotated_at = NOW(), updated_at = NOW(),
             mcp_connection_state = 'unconfigured', mcp_state_updated_at = NOW(),
             mcp_connected_at = NULL, mcp_last_seen_at = NULL
         WHERE host_id = $3 AND bot_id = $4 AND revoked_at IS NULL
           AND status IN ('active', 'standby') AND credential_hash IS NOT NULL
         RETURNING status",
    )
    .bind(hash)
    .bind(&prefix)
    .bind(&host_id)
    .bind(&bot_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound);
    };
    if row.try_get::<String, _>("status").ok().as_deref() == Some("active") {
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
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2
           AND status = 'active' AND revoked_at IS NULL)",
    )
    .bind(&host_id)
    .bind(&bot_id)
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
    let previous_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2 FOR UPDATE",
    )
    .bind(&host_id)
    .bind(&bot_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(previous_status) = previous_status else {
        return Err(AppError::NotFound);
    };
    if previous_status == "pending" {
        sqlx::query(
            "UPDATE enrollment_codes SET revoked = TRUE
             WHERE host_id = $1 AND bot_id = $2
               AND redeemed_at IS NULL AND NOT revoked",
        )
        .bind(&host_id)
        .bind(&bot_id)
        .execute(&mut *tx)
        .await?;
    }
    let revoked_status = status_after_revoke(&previous_status);
    sqlx::query(
        "UPDATE connector_hosts
         SET revoked_at = COALESCE(revoked_at, NOW()), status = $3,
             mcp_connection_state = 'revoked', mcp_state_updated_at = NOW(), updated_at = NOW()
         WHERE host_id = $1 AND bot_id = $2",
    )
    .bind(&host_id)
    .bind(&bot_id)
    .bind(revoked_status)
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

    let revoked_at: Option<Option<chrono::DateTime<chrono::Utc>>> = sqlx::query_scalar(
        "SELECT revoked_at FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2
         FOR UPDATE",
    )
    .bind(&host_id)
    .bind(&bot_id)
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

    sqlx::query(
        "DELETE FROM connector_hosts
         WHERE host_id = $1 AND bot_id = $2",
    )
    .bind(&host_id)
    .bind(&bot_id)
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
