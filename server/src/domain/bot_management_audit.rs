use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

/// Append a durable management event. Audit failure is logged but must not
/// turn an already-successful control action into a misleading API failure.
pub async fn record(
    db: &PgPool,
    event_type: &str,
    bot_id: Option<&str>,
    host_id: Option<&str>,
    actor_id: Option<&str>,
    detail: Value,
) {
    if let Err(error) = sqlx::query!(
        "INSERT INTO bot_management_audit
         (id, event_type, bot_id, host_id, actor_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6)",
        Uuid::new_v4().to_string(),
        event_type,
        bot_id,
        host_id,
        actor_id,
        detail,
    )
    .execute(db)
    .await
    {
        tracing::error!(%error, %event_type, ?bot_id, ?host_id, "failed to append bot management audit");
    }
}
