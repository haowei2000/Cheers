use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    api::{apple_auth, middleware::Claims},
    app_state::AppState,
    domain::auth_sessions,
    errors::AppError,
};

#[derive(Serialize)]
pub struct ExternalIdentityStatus {
    provider: String,
    linked: bool,
    display_name: Option<String>,
    email: Option<String>,
    has_password: bool,
    can_unlink: bool,
    recent_authentication: bool,
}

fn checked_provider(provider: &str) -> Result<&str, AppError> {
    match provider {
        "apple" | "google" => Ok(provider),
        _ => Err(AppError::NotFound),
    }
}

pub async fn status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(provider): Path<String>,
) -> Result<Json<ExternalIdentityStatus>, AppError> {
    let provider = checked_provider(&provider)?;
    let identity = sqlx::query(
        "SELECT display_name, email FROM auth_external_identities
         WHERE user_id = $1 AND provider = $2
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&claims.sub)
    .bind(provider)
    .fetch_optional(&state.db)
    .await?;
    let alternatives: i64 = sqlx::query_scalar(
        "SELECT
           (CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) +
           (SELECT COUNT(*) FROM auth_external_identities
              WHERE user_id = users.user_id AND provider <> $2) +
           (SELECT COUNT(*) FROM webauthn_credentials
              WHERE user_id = users.user_id)
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .bind(provider)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let has_password: bool = sqlx::query_scalar(
        "SELECT password_hash IS NOT NULL FROM users
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let recent_authentication =
        auth_sessions::require_recent_auth(&state.db, &claims.sub, &claims.sid)
            .await
            .is_ok();
    Ok(Json(ExternalIdentityStatus {
        provider: provider.to_owned(),
        linked: identity.is_some(),
        display_name: identity
            .as_ref()
            .and_then(|row| row.try_get("display_name").ok()),
        email: identity.as_ref().and_then(|row| row.try_get("email").ok()),
        has_password,
        can_unlink: identity.is_some() && alternatives > 0,
        recent_authentication,
    }))
}

pub async fn link(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(provider): Path<String>,
    Json(request): Json<apple_auth::AppleAuthorizationRequest>,
) -> Result<Json<Value>, AppError> {
    if checked_provider(&provider)? != "apple" {
        return Err(AppError::BadRequest(
            "Google account linking is not available through the native Apple flow".into(),
        ));
    }
    auth_sessions::require_recent_auth(&state.db, &claims.sub, &claims.sid).await?;
    apple_auth::link(State(state), Extension(claims), Json(request)).await
}

pub async fn unlink(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(provider): Path<String>,
) -> Result<Json<Value>, AppError> {
    let provider = checked_provider(&provider)?;
    auth_sessions::require_recent_auth(&state.db, &claims.sub, &claims.sid).await?;

    let mut tx = state.db.begin().await?;
    // Serialize identity removal per user. Otherwise simultaneous Apple and
    // Google requests could each observe the other as the remaining method.
    let active_user =
        sqlx::query("SELECT 1 FROM users WHERE user_id = $1 AND is_deleted = FALSE FOR UPDATE")
            .bind(&claims.sub)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
    if !active_user {
        return Err(AppError::NotFound);
    }
    let alternatives: i64 = sqlx::query_scalar(
        "SELECT
           (CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) +
           (SELECT COUNT(*) FROM auth_external_identities
              WHERE user_id = users.user_id AND provider <> $2) +
           (SELECT COUNT(*) FROM webauthn_credentials
              WHERE user_id = users.user_id)
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .bind(provider)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if alternatives == 0 {
        return Err(AppError::Conflict(
            "add another sign-in method before unlinking this identity".into(),
        ));
    }

    let linked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM auth_external_identities
         WHERE user_id = $1 AND provider = $2)",
    )
    .bind(&claims.sub)
    .bind(provider)
    .fetch_one(&mut *tx)
    .await?;
    if !linked {
        return Err(AppError::NotFound);
    }

    // Apple issues a revocable refresh credential. Revoke it remotely before
    // deleting local ownership so a provider outage cannot create a false
    // successful unlink. Google OAuth requests no offline access.
    if provider == "apple" {
        apple_auth::revoke_for_user(&state, &claims.sub).await?;
    }
    sqlx::query("DELETE FROM auth_external_identities WHERE user_id = $1 AND provider = $2")
        .bind(&claims.sub)
        .bind(provider)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    auth_sessions::revoke_other_sessions_and_trusted_devices(&state.db, &claims.sub, &claims.sid)
        .await?;
    Ok(Json(json!({"provider": provider, "linked": false})))
}
