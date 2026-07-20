//! Official workbench scenario templates — embedded in the gateway binary and seeded
//! into `workbench_templates` at startup, so a fresh install has working boards with
//! zero admin steps. Templates are DATA (declarative manifests referencing built-in
//! lenses only), which is why this needs none of the plugin sandbox machinery.
//!
//! Policy is identical to official plugins and REUSES `workbench_official::decide`:
//! - the binary is the source of truth (`origin='system'`);
//! - an admin deletion sticks within a release; a HIGHER manifest `version` re-seeds;
//! - a row an admin claimed under the same id is never overwritten.

use serde_json::Value;
use sqlx::PgPool;
use tracing::{info, warn};

use super::workbench_official::{decide, Action};

/// The official scenario set (one manifest JSON per template).
pub const OFFICIAL: &[&str] = &[
    include_str!("../../assets/workbench-templates/task-board.template.json"),
    include_str!("../../assets/workbench-templates/code-project.template.json"),
    include_str!("../../assets/workbench-templates/research-lab.template.json"),
    include_str!("../../assets/workbench-templates/team-ops.template.json"),
];

/// Minimal structural check for an embedded manifest. The full lens-id validation lives
/// in the frontend (lenses are a client vocabulary); the server only guarantees shape.
pub fn validate(manifest: &Value) -> Result<(), String> {
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .ok_or("manifest missing string `id`")?;
    if id.is_empty() || id.len() > 64 {
        return Err("`id` must be 1..=64 chars".into());
    }
    manifest
        .get("title")
        .and_then(Value::as_str)
        .ok_or("manifest missing string `title`")?;
    if !manifest.get("views").is_some_and(Value::is_array) {
        return Err("manifest missing array `views`".into());
    }
    Ok(())
}

/// Seed the official set. Called once at gateway startup (after migrations). Per-template
/// problems are logged and skipped, never fatal — a bad manifest must not stop the boot.
pub async fn seed(db: &PgPool) -> Result<(), sqlx::Error> {
    for raw in OFFICIAL {
        let manifest: Value = match serde_json::from_str(raw) {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "official template is not valid JSON; skipping");
                continue;
            }
        };
        if let Err(e) = validate(&manifest) {
            warn!(error = %e, "official template failed validation; skipping");
            continue;
        }
        let id = manifest["id"].as_str().unwrap_or_default().to_string();
        let version = manifest.get("version").and_then(Value::as_i64).unwrap_or(1);
        // INT column; a wrapping cast could go negative and resurrect deletions.
        let Ok(_version_i32) = i32::try_from(version) else {
            warn!(template = %id, version, "official template version does not fit i32; skipping");
            continue;
        };

        let seeded: Option<i32> = sqlx::query_scalar(
            "SELECT seeded_version FROM workbench_official_template_state WHERE tpl_id = $1",
        )
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let origin: Option<String> =
            sqlx::query_scalar("SELECT origin FROM workbench_templates WHERE tpl_id = $1")
                .bind(&id)
                .fetch_optional(db)
                .await?;

        match decide(version, seeded.map(i64::from), origin.as_deref()) {
            Action::Install => {
                let title = manifest["title"].as_str().unwrap_or(&id);
                sqlx::query(
                    "INSERT INTO workbench_templates (tpl_id, title, manifest, installed_by, origin)
                     VALUES ($1, $2, $3, 'system', 'system')
                     ON CONFLICT (tpl_id)
                     DO UPDATE SET title = $2, manifest = $3, origin = 'system', updated_at = NOW()",
                )
                .bind(&id)
                .bind(title)
                .bind(manifest.to_string())
                .execute(db)
                .await?;
                sqlx::query(
                    "INSERT INTO workbench_official_template_state (tpl_id, seeded_version)
                     VALUES ($1, $2)
                     ON CONFLICT (tpl_id)
                     DO UPDATE SET seeded_version = $2, updated_at = NOW()",
                )
                .bind(&id)
                .bind(version as i32)
                .execute(db)
                .await?;
                info!(template = %id, version, "official template seeded");
            }
            Action::Noop | Action::SkipAdminClaimed => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI gate: every embedded official template must parse and validate, and ids must
    /// be unique — a typo here should fail the build, not warn at some future boot.
    #[test]
    fn embedded_templates_are_well_formed() {
        let mut ids = std::collections::HashSet::new();
        for raw in OFFICIAL {
            let m: Value = serde_json::from_str(raw).expect("official template is valid JSON");
            validate(&m).expect("official template validates");
            assert!(
                ids.insert(m["id"].as_str().unwrap().to_string()),
                "duplicate official template id"
            );
            // Views may only reference the built-in lens vocabulary — templates are data
            // and must never depend on a plugin being installed.
            for v in m["views"].as_array().unwrap() {
                let lens = v["lens"].as_str().expect("view has a lens id");
                assert!(
                    ["table", "kanban", "markdown", "chart"].contains(&lens),
                    "official template references non-builtin lens `{lens}`"
                );
            }
            // Every viewed file must be seeded, or activation shows an empty board.
            let seed = m["seed"]
                .as_object()
                .expect("official template seeds files");
            for v in m["views"].as_array().unwrap() {
                let file = v["file"].as_str().unwrap();
                assert!(seed.contains_key(file), "view file `{file}` is not seeded");
            }
        }
    }
}
