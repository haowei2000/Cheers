use serde_json::Value;
use sqlx::PgPool;

pub const VOICE: &str = "voice";

pub fn supported(feature: &str) -> bool {
    matches!(feature, VOICE)
}

pub async fn list(db: &PgPool, channel_id: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar!(
        "SELECT feature FROM channel_features
         WHERE channel_id = $1 AND enabled = TRUE ORDER BY feature",
        channel_id,
    )
    .fetch_all(db)
    .await
}

pub async fn enabled(db: &PgPool, channel_id: &str, feature: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 AS present FROM channel_features
          WHERE channel_id = $1 AND feature = $2 AND enabled = TRUE) AS "value!" "#,
        channel_id,
        feature,
    )
    .fetch_one(db)
    .await
}

pub async fn enable(
    db: &PgPool,
    channel_id: &str,
    feature: &str,
    config: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO channel_features (channel_id, feature, config, enabled)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (channel_id, feature) DO UPDATE
           SET enabled = TRUE, updated_at = NOW()",
        channel_id,
        feature,
        config,
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn disable(db: &PgPool, channel_id: &str, feature: &str) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE channel_features SET enabled = FALSE, updated_at = NOW()
         WHERE channel_id = $1 AND feature = $2",
        channel_id,
        feature,
    )
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_standard_features_are_accepted() {
        assert!(supported(VOICE));
        assert!(!supported("github"));
        assert!(!supported("arbitrary-server-code"));
    }
}
