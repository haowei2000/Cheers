use serde_json::Value;
use sqlx::{PgPool, Row};
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
    let row = sqlx::query(
        "SELECT channel_id AS id, name, type AS channel_type, workspace_id,
                purpose AS topic, created_at, auto_assist
         FROM channels WHERE channel_id = $1",
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .ok_or_else(|| not_found("channel"))?;

    let member_count: i64 =
        sqlx::query("SELECT COUNT(*) AS cnt FROM channel_memberships WHERE channel_id = $1")
            .bind(channel_id.to_string())
            .fetch_one(db)
            .await
            .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))
            .and_then(|r| {
                r.try_get::<i64, _>("cnt")
                    .map_err(|_| super::resource_error("INTERNAL_ERROR", "count error"))
            })?;

    Ok(serde_json::json!({
        "channel_id": row.try_get::<String, _>("id").unwrap_or_default(),
        "name": row.try_get::<String, _>("name").unwrap_or_default(),
        "type": row.try_get::<String, _>("channel_type").unwrap_or_default(),
        "workspace_id": row.try_get::<Option<String>, _>("workspace_id").unwrap_or(None),
        "topic": row.try_get::<Option<String>, _>("topic").unwrap_or(None),
        "created_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
        "member_count": member_count,
        "auto_assist": row.try_get::<Option<bool>, _>("auto_assist").unwrap_or(None),
    }))
}
