//! Bot write-back for generic channel workflow profile state.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    authorize_channel_write, db_err, resource_error, Principal, PrincipalType, ResourceResult,
};

pub async fn handle_code_status(
    db: &PgPool,
    principal: &Principal,
    params: &Value,
) -> ResourceResult {
    if principal.principal_type != PrincipalType::Bot {
        return Err(resource_error(
            "PERMISSION_DENIED",
            "Code workspace status can only be reported by a Bot",
        ));
    }
    let channel_id = params
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| resource_error("INVALID_PARAMS", "channel_id required"))?;
    authorize_channel_write(db, principal, channel_id).await?;

    let profile = crate::domain::channel_profiles::get(db, &channel_id.to_string())
        .await
        .map_err(db_err("channel.code.status.write: load profile"))?
        .ok_or_else(|| resource_error("NOT_FOUND", "Code profile not found"))?;
    if profile.profile != "code" {
        return Err(resource_error(
            "INVALID_PARAMS",
            "channel is not a Code profile",
        ));
    }
    if profile
        .config
        .get("execution_target")
        .and_then(|target| target.get("bot_id"))
        .and_then(Value::as_str)
        .is_some_and(|bot_id| bot_id != principal.principal_id.to_string())
    {
        return Err(resource_error(
            "PERMISSION_DENIED",
            "this Code profile is assigned to another Bot",
        ));
    }

    let state = params
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("ready");
    if !matches!(state, "importing" | "ready" | "syncing" | "error") {
        return Err(resource_error(
            "INVALID_PARAMS",
            "unsupported Code profile state",
        ));
    }
    let bounded = |key: &str, limit: usize| -> Result<Option<String>, (String, String)> {
        let value = params
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if value.as_ref().is_some_and(|value| value.len() > limit) {
            return Err(resource_error(
                "INVALID_PARAMS",
                format!("{key} is too long"),
            ));
        }
        Ok(value)
    };
    let status = crate::domain::channel_profiles::CodeProfileStatus {
        state: state.to_owned(),
        head_commit: bounded("head_commit", 128)?,
        last_error: bounded("last_error", 2000)?,
    };
    crate::domain::channel_profiles::update_code_status(db, &channel_id.to_string(), &status)
        .await
        .map_err(db_err("channel.code.status.write: update profile"))?
        .ok_or_else(|| resource_error("NOT_FOUND", "Code profile not found"))?;

    Ok(json!({
        "channel_id": channel_id,
        "profile": "code",
        "status": status,
    }))
}
