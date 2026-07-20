//! Global workbench scenario templates: list / put / delete.
//! A template is DATA (a declarative manifest, no executable code) — so unlike a plugin
//! it needs no sandbox. It is server-level (global): an admin installs it, every user
//! sees it. This mirrors the plugin store but stores a manifest instead of a code bundle.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

/// List installed global templates (manifest parsed back to JSON for the client).
pub async fn list(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT tpl_id, title, manifest, origin FROM workbench_templates ORDER BY installed_at DESC",
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
                "tpl_id": r.try_get::<String, _>("tpl_id").unwrap_or_default(),
                "title": r.try_get::<String, _>("title").unwrap_or_default(),
                "manifest": manifest,
                // 'system' = seeded official (badge in Settings); 'admin' = API-installed.
                "origin": r.try_get::<String, _>("origin").unwrap_or_else(|_| "admin".into()),
            })
        })
        .collect())
}

/// Install or update a global template (upsert; admin enforced at the API layer).
pub async fn put(
    db: &PgPool,
    tpl_id: &str,
    title: &str,
    manifest: &str,
    installed_by: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO workbench_templates (tpl_id, title, manifest, installed_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tpl_id)
         DO UPDATE SET title = $2, manifest = $3, updated_at = NOW()",
    )
    .bind(tpl_id)
    .bind(title)
    .bind(manifest)
    .bind(installed_by)
    .execute(db)
    .await?;
    Ok(())
}

/// Delete a global template. Returns rows affected (0 = not found).
pub async fn delete(db: &PgPool, tpl_id: &str) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM workbench_templates WHERE tpl_id = $1")
        .bind(tpl_id)
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}
