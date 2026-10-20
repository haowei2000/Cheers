//! Shared authorization and input policy for every human message producer.
//!
//! REST, scheduled sends, and integration delivery all enter `messages::create_message`.
//! Consent uses the same resolved bot targets as dispatch, including names, replies,
//! default bots, and explicit sessions.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    domain::{dms, messages::CreateMessageParams},
    errors::AppError,
    resource::{authorize_channel_write, Principal},
};

pub(crate) async fn authorize_human_send(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
) -> Result<String, AppError> {
    let membership = authorize_channel_write(db, &Principal::user(user_id), channel_id)
        .await
        .map_err(|(code, message)| match code.as_str() {
            "INTERNAL_ERROR" => AppError::Internal(message),
            _ => AppError::Forbidden(message),
        })?;
    let author = sqlx::query!(
        "SELECT is_suspended, is_deleted FROM users WHERE user_id = $1",
        user_id.to_string(),
    )
    .fetch_optional(db)
    .await?;
    if author.is_none_or(|user| user.is_suspended || user.is_deleted) {
        return Err(AppError::Forbidden("message author is not active".into()));
    }
    dms::ensure_can_message(db, channel_id, user_id).await?;
    Ok(membership.role)
}

/// Resolve INITIATE once, before consent and persistence, and reuse this exact set
/// for dispatch. A denied external bot must not prevent ordinary human chat.
pub(crate) async fn filter_prompt_bots(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
    role: &str,
    candidates: Vec<Uuid>,
) -> Result<Vec<Uuid>, AppError> {
    let mut allowed = Vec::with_capacity(candidates.len());
    for bot_id in candidates {
        let may_prompt = crate::domain::acp_policy::allows(
            db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            role,
            "session/prompt",
            crate::domain::bot_event_policy::Capability::Initiate,
        )
        .await?;
        if may_prompt {
            allowed.push(bot_id);
        } else {
            tracing::info!(%bot_id, %user_id, role, "INITIATE(prompt) denied; message may post without triggering this bot");
        }
    }
    Ok(allowed)
}

/// Fail closed only for external bots this message will actually trigger. Human
/// chat remains available when consent is declined.
pub(crate) async fn ensure_bot_consents(
    db: &PgPool,
    user_id: &str,
    channel_id: Uuid,
    bot_ids: &[Uuid],
) -> Result<(), AppError> {
    if bot_ids.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query!(
        "SELECT b.bot_id, COALESCE(b.display_name,b.username) AS bot_name, b.processor_name,
                b.processor_privacy_url, b.processor_data_use, b.processor_policy_version
         FROM channel_memberships m JOIN bot_accounts b ON b.bot_id = m.member_id
         WHERE m.channel_id = $1 AND m.member_type = 'bot' AND b.external_processor = TRUE",
        channel_id.to_string(),
    )
    .fetch_all(db)
    .await?;
    let mut missing = Vec::new();
    for row in rows {
        let bot_id: String = row.bot_id.clone();
        if !bot_ids.iter().any(|id| id.to_string() == bot_id) {
            continue;
        }
        let version: String = row.processor_policy_version.clone();
        let consented = sqlx::query!(
            "SELECT 1 AS present FROM ai_data_consents WHERE user_id=$1 AND channel_id=$2 AND bot_id=$3 AND policy_version=$4 AND revoked_at IS NULL",
            user_id,
            channel_id.to_string(),
            &bot_id,
            &version,
        ).fetch_optional(db).await?.is_some();
        if !consented {
            missing.push(json!({
                "bot_id": bot_id,
                "bot_name": row.bot_name.clone().unwrap_or_default(),
                "provider_name": row.processor_name.clone(),
                "privacy_url": row.processor_privacy_url.clone(),
                "data_use": row.processor_data_use.clone(),
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

pub(super) async fn validate_resource_interaction(
    db: &PgPool,
    request: &CreateMessageParams,
    event: &Value,
) -> Result<(), AppError> {
    let user_id = request.user_id;
    let channel_id = request.channel_id;
    cheers_mcp_server::interactive::validate_interaction(event)
        .map_err(|error| AppError::BadRequest(error.into()))?;
    if request.msg_type.as_deref().unwrap_or("text") != "text" {
        return Err(AppError::BadRequest(
            "resource requests must be text messages".into(),
        ));
    }
    let bot_id = Uuid::parse_str(event["botId"].as_str().unwrap())
        .map_err(|_| AppError::BadRequest("invalid target bot".into()))?;
    if request.mention_ids != vec![bot_id]
        || !request.mention_names.is_empty()
        || request.session_id.is_some()
    {
        return Err(AppError::BadRequest(
            "resource requests must target exactly the declared bot".into(),
        ));
    }
    crate::resource::authorize_channel_write(
        db,
        &crate::resource::Principal::bot(bot_id),
        channel_id,
    )
    .await
    .map_err(|(_, message)| AppError::Forbidden(message))?;
    let uri = event["sourceUri"].as_str().unwrap_or("");
    let principal = crate::resource::Principal::user(user_id);
    let resolved =
        crate::api::resources::desk_resource(db, &principal, uri, Some(channel_id)).await?;
    if resolved.channel_id != channel_id.to_string()
        || resolved.version != resolved.latest_version
        || resolved.deleted
    {
        return Err(AppError::Conflict(
            "The source changed or belongs to another channel.".into(),
        ));
    }
    let path = resolved.path;
    let source = crate::resource::fs::handle_read(
        db,
        &principal,
        &serde_json::json!({"channel_id":channel_id,"path":path}),
    )
    .await
    .map_err(|(_, message)| AppError::BadRequest(message))?;
    if source["version"] != event["sourceVersion"] {
        return Err(AppError::Conflict(
            "The interactive resource changed. Reload it before submitting.".into(),
        ));
    }
    let content = source["content"].as_str().unwrap_or("");
    let actions = cheers_mcp_server::interactive::extract_action_declarations(
        &path,
        content,
        source.get("data"),
    )
    .map_err(|error| AppError::BadRequest(error.into()))?;

    let action_id = event["actionId"].as_str().unwrap();
    let action = actions
        .iter()
        .find(|a| {
            a.action_id == action_id
                && a.surface_id.as_deref() == event["surfaceId"].as_str()
                && a.component_id.as_deref() == event["componentId"].as_str()
        })
        .ok_or_else(|| AppError::BadRequest("source action not found".into()))?;

    if action.name != "cheers.request" || action.bot_id.as_deref() != event["botId"].as_str() {
        return Err(AppError::BadRequest(
            "interaction does not match the source action".into(),
        ));
    }

    let supplied = event["input"]
        .as_object()
        .ok_or_else(|| AppError::BadRequest("interaction input must be an object".into()))?;
    cheers_mcp_server::interactive::validate_action_input(&action.payload, supplied).map_err(
        |_| AppError::BadRequest("interaction inputs do not match the source payload".into()),
    )?;

    Ok(())
}
