//! Server-level workbench plugins: install / list / fetch-bundle / delete.
//! A plugin is admin-installed and global (all channels see it). The bundle is opaque
//! to the server — it runs sandboxed in the browser. The MANIFEST is not opaque:
//! installs validate it against the protocol-1 shape (docs/developer/PLUGIN_DEVELOPMENT.md)
//! so a broken or legacy plugin is rejected with a named reason instead of being served
//! to every channel and failing there.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

/// Hard cap for a plugin bundle (also the sane ceiling for an iframe srcDoc). The
/// frontend mirrors this on the session (temporary) load path.
pub const MAX_BUNDLE_BYTES: usize = 2 * 1024 * 1024;
/// Hard cap for the serialized manifest.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// The plugin protocol this server accepts. A manifest without `protocol` defaults to 1
/// (the documented default covering pre-field installs).
pub const PLUGIN_PROTOCOL: i64 = 1;

fn plugin_id_ok(id: &str) -> bool {
    // ^[a-z0-9][a-z0-9._-]{0,63}$  (DB column is VARCHAR(64))
    let b = id.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn validate_match(m: &Value) -> Result<(), String> {
    let mo = m.as_object().ok_or("renderer match must be an object")?;
    // Known keys are type-checked; UNKNOWN keys are allowed — hosts ignore them, which
    // is what lets the match vocabulary grow within protocol 1.
    if let Some(f) = mo.get("format") {
        let ok = f.is_string()
            || f.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string));
        if !ok {
            return Err("match.format must be a string or a non-empty array of strings".into());
        }
    }
    if let Some(g) = mo.get("glob") {
        if !g.is_string() {
            return Err("match.glob must be a string".into());
        }
    }
    for key in ["requireAll", "requireAny", "dataHas", "jsonHas"] {
        if let Some(v) = mo.get(key) {
            if !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)) {
                return Err(format!("match.{key} must be an array of strings"));
            }
        }
    }
    if let Some(k) = mo.get("dataKind") {
        if !matches!(k.as_str(), Some("object" | "array")) {
            return Err("match.dataKind must be \"object\" or \"array\"".into());
        }
    }
    Ok(())
}

/// Install-time manifest validation (protocol 1). Pure; returns the rejection reason.
pub fn validate_manifest(plugin_id: &str, manifest: &Value) -> Result<(), String> {
    if !plugin_id_ok(plugin_id) {
        return Err("plugin id must match ^[a-z0-9][a-z0-9._-]{0,63}$".into());
    }
    let obj = manifest
        .as_object()
        .ok_or("manifest must be a JSON object")?;
    match obj.get("id").and_then(Value::as_str) {
        Some(id) if id == plugin_id => {}
        Some(_) => return Err("manifest.id must equal the plugin id in the URL".into()),
        None => return Err("manifest.id must be a non-empty string".into()),
    }
    let title = obj.get("title").and_then(Value::as_str).unwrap_or("");
    if title.trim().is_empty() || title.len() > 255 {
        return Err("manifest.title must be a non-empty string (max 255 bytes)".into());
    }
    if let Some(p) = obj.get("protocol") {
        // Accept any JSON NUMBER equal to 1 (so `1.0` too): the frontend cannot be
        // stricter — JSON.parse collapses 1.0 to 1 — and the two hosts must accept
        // the same manifests. Strings ("1") are still not versions.
        let is_v1 =
            p.as_i64() == Some(PLUGIN_PROTOCOL) || p.as_f64() == Some(PLUGIN_PROTOCOL as f64);
        if !is_v1 {
            return Err(format!(
                "unsupported protocol {p} (this server accepts protocol {PLUGIN_PROTOCOL}; omit the field or set {PLUGIN_PROTOCOL})"
            ));
        }
    }
    if obj.contains_key("panels") {
        return Err(
            "legacy scenario-plugin manifest (`panels`): that protocol is retired — declare renderers[] instead; see docs/developer/PLUGIN_DEVELOPMENT.md"
                .into(),
        );
    }
    let renderers = obj
        .get("renderers")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("manifest.renderers must be a non-empty array")?;
    let mut seen = std::collections::HashSet::new();
    for r in renderers {
        let ro = r.as_object().ok_or("each renderer must be an object")?;
        let rid = ro.get("id").and_then(Value::as_str).unwrap_or("");
        if rid.trim().is_empty() || rid.len() > 64 {
            return Err("each renderer needs a non-empty string id (max 64 bytes)".into());
        }
        if !seen.insert(rid) {
            return Err(format!("duplicate renderer id: {rid}"));
        }
        let rtitle = ro.get("title").and_then(Value::as_str).unwrap_or("");
        if rtitle.trim().is_empty() {
            return Err("each renderer needs a non-empty string title".into());
        }
        if let Some(m) = ro.get("match") {
            validate_match(m)?;
        }
    }
    Ok(())
}

/// List installed plugins (metadata only — manifest parsed, bundle omitted to stay light).
pub async fn list(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT plugin_id, title, manifest, origin FROM workbench_plugins ORDER BY installed_at DESC",
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
                "origin": r.try_get::<String, _>("origin").unwrap_or_else(|_| "admin".into()),
            })
        })
        .collect())
}

/// The origin of an installed plugin ('admin' | 'system'), or None if not installed.
pub async fn get_origin(db: &PgPool, plugin_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT origin FROM workbench_plugins WHERE plugin_id = $1")
        .bind(plugin_id)
        .fetch_optional(db)
        .await
}

/// The sandboxed bundle (HTML/JS) for one plugin, or None if not installed.
pub async fn get_bundle(db: &PgPool, plugin_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT bundle FROM workbench_plugins WHERE plugin_id = $1")
        .bind(plugin_id)
        .fetch_optional(db)
        .await
}

/// Install or update a plugin. Admin-only on the API path (which also refuses to touch
/// `origin='system'` rows); the startup seeder calls this with origin='system'.
pub async fn install(
    db: &PgPool,
    plugin_id: &str,
    title: &str,
    manifest: &str,
    bundle: &str,
    installed_by: &str,
    origin: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO workbench_plugins (plugin_id, title, manifest, bundle, installed_by, origin)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (plugin_id)
         DO UPDATE SET title = $2, manifest = $3, bundle = $4, origin = $6, updated_at = NOW()",
    )
    .bind(plugin_id)
    .bind(title)
    .bind(manifest)
    .bind(bundle)
    .bind(installed_by)
    .bind(origin)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok_manifest() -> Value {
        json!({
            "id": "md-checklist",
            "title": "Markdown checklist",
            "protocol": 1,
            "renderers": [
                { "id": "checklist", "title": "Checklist",
                  "match": { "format": "markdown", "requireAny": ["- [ ]", "- [x]"] } }
            ]
        })
    }

    #[test]
    fn accepts_well_formed_manifest() {
        assert_eq!(validate_manifest("md-checklist", &ok_manifest()), Ok(()));
    }

    #[test]
    fn protocol_absent_defaults_to_1() {
        let mut m = ok_manifest();
        m.as_object_mut().unwrap().remove("protocol");
        assert_eq!(validate_manifest("md-checklist", &m), Ok(()));
    }

    #[test]
    fn rejects_unsupported_protocol() {
        let mut m = ok_manifest();
        m["protocol"] = json!(2);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("protocol"));
        m["protocol"] = json!("1"); // strings are not versions
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("protocol"));
    }

    #[test]
    fn accepts_any_json_number_equal_to_1_as_protocol() {
        // JSON.parse collapses 1.0 to 1, so the frontend cannot distinguish them —
        // installs must not be stricter than session loads.
        let mut m = ok_manifest();
        m["protocol"] = json!(1.0);
        assert_eq!(validate_manifest("md-checklist", &m), Ok(()));
        m["protocol"] = json!(1.5);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("protocol"));
        m["protocol"] = json!("2");
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("protocol"));
    }

    #[test]
    fn rejects_legacy_panels_manifest() {
        let mut m = ok_manifest();
        m["panels"] = json!([{ "id": "notes", "title": "Notes" }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("legacy"));
    }

    #[test]
    fn rejects_id_mismatch_and_bad_ids() {
        assert!(validate_manifest("other-id", &ok_manifest())
            .unwrap_err()
            .contains("equal"));
        assert!(validate_manifest("Bad_Upper", &ok_manifest()).is_err());
        assert!(validate_manifest("-leading-dash", &ok_manifest()).is_err());
        assert!(validate_manifest(&"x".repeat(65), &ok_manifest()).is_err());
    }

    #[test]
    fn rejects_missing_or_empty_renderers() {
        let mut m = ok_manifest();
        m["renderers"] = json!([]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("renderers"));
        m.as_object_mut().unwrap().remove("renderers");
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("renderers"));
    }

    #[test]
    fn rejects_duplicate_or_malformed_renderers() {
        let mut m = ok_manifest();
        m["renderers"] = json!([
            { "id": "dup", "title": "One" },
            { "id": "dup", "title": "Two" }
        ]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("duplicate"));
        m["renderers"] = json!([{ "title": "no id" }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("id"));
        m["renderers"] = json!([{ "id": "r" }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("title"));
    }

    #[test]
    fn type_checks_known_match_keys_but_ignores_unknown_ones() {
        let mut m = ok_manifest();
        m["renderers"] = json!([{ "id": "r", "title": "R",
            "match": { "format": ["json", "yaml"], "dataKind": "array",
                       "dataHas": ["rows"], "futureKey": { "anything": true } } }]);
        assert_eq!(validate_manifest("md-checklist", &m), Ok(()));
        m["renderers"] = json!([{ "id": "r", "title": "R", "match": { "dataKind": "tuple" } }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("dataKind"));
        m["renderers"] = json!([{ "id": "r", "title": "R", "match": { "format": [] } }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("format"));
        m["renderers"] = json!([{ "id": "r", "title": "R", "match": { "requireAll": "x" } }]);
        assert!(validate_manifest("md-checklist", &m)
            .unwrap_err()
            .contains("requireAll"));
    }
}
