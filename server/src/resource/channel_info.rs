use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::{authorize_channel_read, not_found, Principal, ResourceResult};

pub async fn handle(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    // The channels table columns are channel_id / type / purpose — alias them to
    // the names this handler reads (id / channel_type / topic). (The old query
    // referenced non-existent id/channel_type/topic columns → "db error".)
    let row = sqlx::query!(
        "SELECT channel_id AS id, name, type AS channel_type, workspace_id,
                purpose AS topic, created_at, auto_assist
         FROM channels WHERE channel_id = $1",
        channel_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(super::db_err("channel_info.read: select channel row"))?
    .ok_or_else(|| not_found("channel"))?;

    let member_count: i64 = sqlx::query!(
        "SELECT COUNT(*) AS cnt FROM channel_memberships WHERE channel_id = $1",
        channel_id.to_string(),
    )
    .fetch_one(db)
    .await
    .map_err(super::db_err("channel_info.read: count memberships"))
    .and_then(|r| {
        r.cnt
            .clone()
            .ok_or_else(|| sqlx::Error::Decode(Box::new(sqlx::error::UnexpectedNullError)))
            .map_err(super::internal_err(
                "INTERNAL_ERROR",
                "count error",
                "channel_info.read: read cnt column",
            ))
    })?;

    Ok(serde_json::json!({
        "channel_id": row.id.clone(),
        "name": row.name.clone(),
        "type": row.channel_type.clone(),
        "workspace_id": Some(row.workspace_id.clone()),
        "topic": row.topic.clone(),
        "created_at": Some(row.created_at.clone()),
        "member_count": member_count,
        "auto_assist": Some(row.auto_assist.clone()),
    }))
}
