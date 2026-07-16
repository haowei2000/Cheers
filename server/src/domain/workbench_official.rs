//! Official workbench plugins — embedded in the gateway binary (include_str!) and
//! seeded into `workbench_plugins` at startup, so a fresh install has a useful
//! renderer set with zero admin steps.
//!
//! Policy (pure `decide`, unit-tested):
//! - the BINARY is the source of truth for official plugins (`origin='system'`);
//! - an admin deletion is sticky across restarts of the same release — only a release
//!   shipping a HIGHER manifest `version` re-seeds that plugin;
//! - a row an admin claimed under the same id (`origin='admin'`) is never overwritten.
//!
//! Sources live in server/assets/workbench-plugins/*.plugin.html (self-contained,
//! also hand-uploadable for testing). A unit test walks every embedded bundle through
//! extract_manifest + validate_manifest, so CI cannot ship a malformed official plugin.

use serde_json::Value;
use sqlx::PgPool;
use tracing::{info, warn};

use super::workbench_plugins;

/// The official set (one self-contained .html per plugin).
pub const OFFICIAL: &[&str] = &[
    include_str!("../../assets/workbench-plugins/cheers-checklist.plugin.html"),
    include_str!("../../assets/workbench-plugins/cheers-table.plugin.html"),
    include_str!("../../assets/workbench-plugins/cheers-kanban-md.plugin.html"),
    include_str!("../../assets/workbench-plugins/cheers-frontmatter.plugin.html"),
];

/// Extract the embedded `#cheers-plugin` manifest from a bundle. A literal substring
/// scan is enough — these files are ours and CI-verified (see module tests).
pub fn extract_manifest(html: &str) -> Result<Value, String> {
    const OPEN: &str = r#"<script type="application/json" id="cheers-plugin">"#;
    let start = html
        .find(OPEN)
        .ok_or("missing #cheers-plugin manifest script")?
        + OPEN.len();
    let end = html[start..]
        .find("</script>")
        .ok_or("unterminated manifest script")?
        + start;
    serde_json::from_str(&html[start..end]).map_err(|e| format!("manifest is not valid JSON: {e}"))
}

/// What the seeder should do for one official plugin.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Noop,
    SkipAdminClaimed,
}

/// Pure seeding policy. `seeded_version` = this DB's state row (None = never seeded:
/// fresh DB or pre-feature DB); `existing_origin` = the current plugin row's origin
/// (None = no row, e.g. admin-deleted).
pub fn decide(
    embedded_version: i64,
    seeded_version: Option<i64>,
    existing_origin: Option<&str>,
) -> Action {
    if existing_origin == Some("admin") {
        // The id belongs to an admin-installed plugin (claimed before this feature, or
        // re-claimed after deleting the official one). Their row, not ours.
        return Action::SkipAdminClaimed;
    }
    match seeded_version {
        None => Action::Install,
        Some(v) if embedded_version > v => Action::Install, // upgrade — restores deletions too
        Some(_) => Action::Noop, // same/older release: an admin deletion stays deleted
    }
}

/// Seed the official set. Called once at gateway startup (after migrations). Upserts
/// are idempotent; per-plugin problems are logged and skipped, never fatal.
pub async fn seed(db: &PgPool) -> Result<(), sqlx::Error> {
    for bundle in OFFICIAL {
        let manifest = match extract_manifest(bundle) {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "official plugin bundle is malformed; skipping");
                continue;
            }
        };
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Err(e) = workbench_plugins::validate_manifest(&id, &manifest) {
            warn!(plugin = %id, error = %e, "official plugin failed manifest validation; skipping");
            continue;
        }
        let version = manifest.get("version").and_then(Value::as_i64).unwrap_or(1);
        // Stored in an INT column — a wrapping `as i32` on an out-of-range version would
        // go negative and re-seed on every startup (resurrecting admin deletions).
        let Ok(version_i32) = i32::try_from(version) else {
            warn!(plugin = %id, version, "official plugin version does not fit i32; skipping");
            continue;
        };

        let seeded: Option<i32> = sqlx::query_scalar(
            "SELECT seeded_version FROM workbench_official_plugin_state WHERE plugin_id = $1",
        )
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let origin: Option<String> =
            sqlx::query_scalar("SELECT origin FROM workbench_plugins WHERE plugin_id = $1")
                .bind(&id)
                .fetch_optional(db)
                .await?;

        match decide(version, seeded.map(i64::from), origin.as_deref()) {
            Action::Install => {
                let title = manifest.get("title").and_then(Value::as_str).unwrap_or(&id);
                workbench_plugins::install(
                    db,
                    &id,
                    title,
                    &manifest.to_string(),
                    bundle,
                    "system",
                    "system",
                )
                .await?;
                sqlx::query(
                    "INSERT INTO workbench_official_plugin_state (plugin_id, seeded_version)
                     VALUES ($1, $2)
                     ON CONFLICT (plugin_id)
                     DO UPDATE SET seeded_version = $2, seeded_at = NOW()",
                )
                .bind(&id)
                .bind(version_i32)
                .execute(db)
                .await?;
                info!(plugin = %id, version, "official workbench plugin seeded");
            }
            Action::Noop => {}
            Action::SkipAdminClaimed => {
                // Documented steady state (admin claimed the id), not a problem — info, not warn.
                info!(plugin = %id, "official plugin id is admin-claimed; leaving their row alone");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI gate: every embedded official bundle must carry a valid protocol-1 manifest.
    #[test]
    fn every_official_bundle_is_valid() {
        assert!(!OFFICIAL.is_empty());
        for bundle in OFFICIAL {
            let m = extract_manifest(bundle).expect("manifest extracts");
            let id = m.get("id").and_then(Value::as_str).expect("has id");
            assert!(
                id.starts_with("cheers-"),
                "official ids use the cheers- prefix: {id}"
            );
            workbench_plugins::validate_manifest(id, &m).expect("manifest validates");
            let version = m.get("version").and_then(Value::as_i64).unwrap_or_else(|| {
                panic!("official manifests carry an integer version (drives re-seeding): {id}")
            });
            assert!(
                i32::try_from(version).is_ok(),
                "official manifest version must fit the INT seeded_version column: {id}"
            );
        }
    }

    #[test]
    fn official_ids_are_unique() {
        let mut ids: Vec<String> = OFFICIAL
            .iter()
            .map(|b| {
                extract_manifest(b).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), OFFICIAL.len());
    }

    #[test]
    fn decide_fresh_db_installs() {
        assert_eq!(decide(1, None, None), Action::Install);
    }

    #[test]
    fn decide_same_version_is_noop_and_keeps_deletions() {
        // present at same version
        assert_eq!(decide(1, Some(1), Some("system")), Action::Noop);
        // admin deleted it; same release restarts must NOT resurrect it
        assert_eq!(decide(1, Some(1), None), Action::Noop);
        // downgrade (rollback deploy): leave the newer data alone
        assert_eq!(decide(1, Some(2), Some("system")), Action::Noop);
    }

    #[test]
    fn decide_version_bump_reinstalls_even_after_deletion() {
        assert_eq!(decide(2, Some(1), Some("system")), Action::Install);
        assert_eq!(decide(2, Some(1), None), Action::Install); // restore deleted
    }

    #[test]
    fn decide_never_touches_admin_claimed_ids() {
        assert_eq!(decide(2, Some(1), Some("admin")), Action::SkipAdminClaimed);
        assert_eq!(decide(1, None, Some("admin")), Action::SkipAdminClaimed);
    }
}
