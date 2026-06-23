//! Server-level workbench plugins: install / list / fetch-bundle / delete.
//! A plugin is admin-installed and global (all channels see it). The bundle is opaque
//! to the server — it runs sandboxed in the browser.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

/// List installed plugins (metadata only — manifest parsed, bundle omitted to stay light).
pub async fn list(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT plugin_id, title, manifest FROM workbench_plugins ORDER BY installed_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let manifest: Value = r
                .try_get::<String, _>("manifest")
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            json!({
                "plugin_id": r.try_get::<String, _>("plugin_id").unwrap_or_default(),
                "title": r.try_get::<String, _>("title").unwrap_or_default(),
                "manifest": manifest,
            })
        })
        .collect())
}

/// The sandboxed bundle (HTML/JS) for one plugin, or None if not installed.
pub async fn get_bundle(db: &PgPool, plugin_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT bundle FROM workbench_plugins WHERE plugin_id = $1")
        .bind(plugin_id)
        .fetch_optional(db)
        .await
}

/// Install or update a plugin (admin only — enforced at the API layer).
pub async fn install(
    db: &PgPool,
    plugin_id: &str,
    title: &str,
    manifest: &str,
    bundle: &str,
    installed_by: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO workbench_plugins (plugin_id, title, manifest, bundle, installed_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (plugin_id)
         DO UPDATE SET title = $2, manifest = $3, bundle = $4, updated_at = NOW()",
    )
    .bind(plugin_id)
    .bind(title)
    .bind(manifest)
    .bind(bundle)
    .bind(installed_by)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete(db: &PgPool, plugin_id: &str) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM workbench_plugins WHERE plugin_id = $1")
        .bind(plugin_id)
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}
