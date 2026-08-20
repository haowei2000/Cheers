//! Official Workbench contributions compiled into the Gateway catalog.

use std::{collections::BTreeMap, sync::LazyLock};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SOURCES: &[&str] = &[
    include_str!("../../../assets/workbench-templates/task-board.template.json"),
    include_str!("../../../assets/workbench-templates/code-project.template.json"),
    include_str!("../../../assets/workbench-templates/research-lab.template.json"),
    include_str!("../../../assets/workbench-templates/team-ops.template.json"),
];

struct OfficialExtension {
    summary: Value,
    scenes: BTreeMap<String, Value>,
}

fn build(source: &str) -> OfficialExtension {
    let source: Value =
        serde_json::from_str(source).expect("official Workbench source is valid JSON");
    let id = source["id"]
        .as_str()
        .expect("official Workbench source has id");
    let title = source["title"]
        .as_str()
        .expect("official Workbench source has title");
    let version = format!(
        "{}.0.0",
        source["version"]
            .as_u64()
            .expect("official Workbench source has version")
    );
    let scene_id = "default";
    let items: Vec<Value> = source["views"]
        .as_array()
        .expect("official Workbench source has views")
        .iter()
        .map(|view| {
            json!({
                "id": view["id"], "title": view["title"], "file": view["file"],
                "renderer": format!("builtin:{}", view["lens"].as_str().unwrap_or("markdown")),
                "config": view.get("config").cloned(),
            })
        })
        .collect();
    let seed: Vec<Value> = source["seed"]
        .as_object()
        .expect("official Workbench source has seed")
        .iter()
        .map(|(path, value)| {
            let content = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_yaml::to_string(value).expect("official seed serializes"));
            json!({"path": path, "content": content})
        })
        .collect();
    let scene = json!({"id": scene_id, "title": title, "items": items, "seed": seed, "pin": source.get("pin").cloned().unwrap_or_else(|| json!([]))});
    let sha256 = format!("{:x}", Sha256::digest(source.to_string().as_bytes()));
    OfficialExtension {
        summary: json!({
            "id": id, "version": version, "title": title,
            "description": "Official Cheers Workbench scenario", "sha256": sha256,
            "origin": "system", "scenes": [{"id": scene_id, "title": title, "definition": "catalog"}],
            "renderers": [], "automations": [], "permissions": {}, "updatedAt": "release"
        }),
        scenes: BTreeMap::from([(scene_id.to_owned(), scene)]),
    }
}

static ALL: LazyLock<Vec<OfficialExtension>> =
    LazyLock::new(|| SOURCES.iter().map(|source| build(source)).collect());

pub fn list() -> Vec<Value> {
    ALL.iter()
        .map(|extension| extension.summary.clone())
        .collect()
}

pub fn get_scene(extension_id: &str, scene_id: &str) -> Option<Value> {
    ALL.iter()
        .find(|extension| extension.summary["id"] == extension_id)
        .and_then(|extension| extension.scenes.get(scene_id))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_workbench_is_release_catalog_data() {
        assert!(!list().is_empty());
        for extension in list() {
            assert_eq!(extension["origin"], "system");
            let scene = get_scene(extension["id"].as_str().unwrap(), "default").unwrap();
            assert!(!scene["items"].as_array().unwrap().is_empty());
        }
    }
}
