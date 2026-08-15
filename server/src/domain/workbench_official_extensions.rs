//! Official scene extensions generated from the repository's declarative scene sources.

use std::io::{Cursor, Write};

use anyhow::{anyhow, Context};
use semver::Version;
use serde_json::{json, Value};
use sqlx::PgPool;
use tracing::info;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use super::workbench_extensions::{self, ValidatedPackage};

pub const OFFICIAL_SOURCES: &[&str] = &[
    include_str!("../../assets/workbench-templates/task-board.template.json"),
    include_str!("../../assets/workbench-templates/code-project.template.json"),
    include_str!("../../assets/workbench-templates/research-lab.template.json"),
    include_str!("../../assets/workbench-templates/team-ops.template.json"),
];

fn should_seed(embedded: &str, seeded: Option<&str>, existing_origin: Option<&str>) -> bool {
    if existing_origin == Some("admin") {
        return false;
    }
    match seeded {
        None => true,
        Some(current) => Version::parse(embedded).ok() > Version::parse(current).ok(),
    }
}

fn source_to_package(source: &str) -> anyhow::Result<ValidatedPackage> {
    let old: Value =
        serde_json::from_str(source).context("official scene source is invalid JSON")?;
    let id = old["id"]
        .as_str()
        .ok_or_else(|| anyhow!("source has no id"))?;
    let title = old["title"]
        .as_str()
        .ok_or_else(|| anyhow!("source has no title"))?;
    let major = old.get("version").and_then(Value::as_u64).unwrap_or(1);
    let scene_id = "default";

    let mut items = Vec::new();
    for view in old["views"]
        .as_array()
        .ok_or_else(|| anyhow!("source views must be an array"))?
    {
        items.push(json!({
            "id": view["id"],
            "title": view["title"],
            "file": view["file"],
            "renderer": format!("builtin:{}", view["lens"].as_str().unwrap_or("markdown")),
            "config": view.get("config").cloned()
        }));
    }

    let mut seed_refs = Vec::new();
    let mut seed_files = Vec::new();
    for (path, value) in old["seed"]
        .as_object()
        .ok_or_else(|| anyhow!("source seed must be an object"))?
    {
        let archive_path = format!("seed/{scene_id}/{path}");
        seed_refs.push(json!({"path": path, "source": archive_path}));
        let content = match value.as_str() {
            Some(text) => text.to_string(),
            None => serde_yaml::to_string(value).context("cannot encode official seed as YAML")?,
        };
        seed_files.push((archive_path, content.into_bytes()));
    }

    let manifest = json!({
        "schemaVersion": 1,
        "id": id,
        "version": format!("{major}.0.0"),
        "title": title,
        "description": "Official Cheers Workbench scene",
        "contributes": {
            "scenes": [{"id": scene_id, "title": title, "definition": "scenes/default.json"}],
            "renderers": []
        },
        "permissions": {}
    });
    let scene = json!({
        "items": items,
        "seed": seed_refs,
        "pin": old.get("pin").cloned().unwrap_or_else(|| json!([]))
    });

    let mut output = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("manifest.json", options)?;
        zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        zip.start_file("scenes/default.json", options)?;
        zip.write_all(serde_json::to_string_pretty(&scene)?.as_bytes())?;
        for (path, content) in seed_files {
            zip.start_file(path, options)?;
            zip.write_all(&content)?;
        }
        zip.finish()?;
    }
    workbench_extensions::validate_package(&output.into_inner(), false).map_err(anyhow::Error::msg)
}

pub async fn seed(db: &PgPool) -> anyhow::Result<()> {
    for source in OFFICIAL_SOURCES {
        let package = source_to_package(source)?;
        let id = &package.manifest.id;
        let seeded: Option<String> = sqlx::query_scalar(
            "SELECT seeded_version FROM workbench_official_extension_state WHERE extension_id=$1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
        let origin = workbench_extensions::origin(db, id).await?;
        if origin.as_deref() == Some("admin") {
            info!(extension = %id, "official extension id is admin-claimed; leaving it unchanged");
            continue;
        }
        let should_install = should_seed(
            &package.manifest.version,
            seeded.as_deref(),
            origin.as_deref(),
        );
        if !should_install {
            continue;
        }
        workbench_extensions::install(db, &package, "system", "system").await?;
        sqlx::query(
            "INSERT INTO workbench_official_extension_state
             (extension_id, seeded_version, package_sha256) VALUES ($1,$2,$3)
             ON CONFLICT (extension_id) DO UPDATE SET
               seeded_version=$2, package_sha256=$3, updated_at=NOW()",
        )
        .bind(id)
        .bind(&package.manifest.version)
        .bind(&package.sha256)
        .execute(db)
        .await?;
        info!(extension = %id, version = %package.manifest.version, "official extension seeded");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_sources_become_valid_data_only_packages() {
        let mut ids = std::collections::HashSet::new();
        for source in OFFICIAL_SOURCES {
            let package = source_to_package(source).expect("official package validates");
            assert!(ids.insert(package.manifest.id.clone()));
            assert!(package.manifest.contributes.renderers.is_empty());
            assert!(!package.scenes["default"].items.is_empty());
            assert!(!package.scenes["default"].seed.is_empty());
        }
    }

    #[test]
    fn deletion_is_sticky_until_a_version_increase() {
        assert!(should_seed("1.0.0", None, None));
        assert!(!should_seed("1.0.0", Some("1.0.0"), None));
        assert!(should_seed("1.1.0", Some("1.0.0"), None));
        assert!(!should_seed("2.0.0", Some("1.0.0"), Some("admin")));
    }
}
