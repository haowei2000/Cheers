use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

pub async fn handle(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(100)
        .min(500);

    let rows = sqlx::query(
        r#"
        SELECT cm.member_id, cm.member_type, cm.joined_at,
               COALESCE(u.display_name, b.display_name) AS display_name,
               COALESCE(u.username, b.username) AS username
        FROM channel_memberships cm
        LEFT JOIN users u ON cm.member_type = 'user' AND u.id = cm.member_id
        LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.id = cm.member_id
        WHERE cm.channel_id = $1
        LIMIT $2
        "#,
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let members: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::json!({
            "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
            "member_type": r.try_get::<String, _>("member_type").unwrap_or_default(),
            "display_name": r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
            "username": r.try_get::<Option<String>, _>("username").unwrap_or(None),
            "joined_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("joined_at").unwrap_or(None),
        }))
        .collect();

    Ok(serde_json::json!({
        "members": members,
        "total": members.len(),
        "next_cursor": null,
    }))
}
