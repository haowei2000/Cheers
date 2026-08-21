//! Official Workbench contributions compiled into the Gateway catalog.

use std::{collections::BTreeMap, sync::LazyLock};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domain::workbench_extensions::{CHANNEL_RESOURCES, PANEL_SOURCE_KINDS};

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
    let panels = build_panels(&source, id);
    let sha256 = format!("{:x}", Sha256::digest(source.to_string().as_bytes()));
    OfficialExtension {
        summary: json!({
            "id": id, "version": version, "title": title,
            "description": "Official Cheers Workbench scenario", "sha256": sha256,
            "origin": "system", "scenes": [{"id": scene_id, "title": title, "definition": "catalog"}],
            "renderers": [], "automations": [], "panels": panels,
            "permissions": {}, "updatedAt": "release"
        }),
        scenes: BTreeMap::from([(scene_id.to_owned(), scene)]),
    }
}

/// A template's optional `panels`: declarative boards over a resource verb or a
/// workspace file, rendered by a compiled built-in view.
///
/// Catalog data is first-party and compiled in, so this panics rather than returning an
/// error — a malformed panel fails the build and the tests, never a request. The
/// vocabulary is deliberately the SAME one the package installers enforce
/// (`workbench_extensions`): the catalog is a second way to declare a panel, not a
/// second grammar, and a source kind or verb that would be rejected in a package must
/// be rejected here too.
fn build_panels(source: &Value, extension_id: &str) -> Vec<Value> {
    let Some(declared) = source.get("panels") else {
        return Vec::new();
    };
    let declared = declared
        .as_array()
        .unwrap_or_else(|| panic!("{extension_id}: panels must be an array"));
    declared
        .iter()
        .map(|panel| {
            let panel_id = panel["id"]
                .as_str()
                .unwrap_or_else(|| panic!("{extension_id}: panel has no id"));
            let title = panel["title"]
                .as_str()
                .unwrap_or_else(|| panic!("{extension_id}/{panel_id}: panel has no title"));
            let kind = panel["source"]["kind"]
                .as_str()
                .unwrap_or_else(|| panic!("{extension_id}/{panel_id}: panel source has no kind"));
            assert!(
                PANEL_SOURCE_KINDS.contains(&kind),
                "{extension_id}/{panel_id}: panel source kind `{kind}` is not one of {PANEL_SOURCE_KINDS:?}"
            );
            if kind == "resource" {
                let verb = panel["source"]["verb"].as_str().unwrap_or_else(|| {
                    panic!("{extension_id}/{panel_id}: resource panel has no verb")
                });
                assert!(
                    CHANNEL_RESOURCES.contains(&verb),
                    "{extension_id}/{panel_id}: panel reads `{verb}`, which is not an allowed channel resource"
                );
                // `pick` names the key to unwrap. Any key is legal — it is a lookup on
                // data the panel already read — but it has to be a name.
                if let Some(pick) = panel["source"].get("pick") {
                    assert!(
                        pick.as_str().is_some_and(|key| !key.is_empty()),
                        "{extension_id}/{panel_id}: panel pick must be a key name"
                    );
                }
            } else {
                assert!(
                    panel["source"].get("pick").is_none(),
                    "{extension_id}/{panel_id}: an fs source has no wrapper to pick from"
                );
                let path = panel["source"]["path"]
                    .as_str()
                    .unwrap_or_else(|| panic!("{extension_id}/{panel_id}: fs panel has no path"));
                assert!(
                    !path.is_empty() && !path.starts_with('/') && !path.contains("..") && !path.contains('\\'),
                    "{extension_id}/{panel_id}: unsafe workspace path `{path}`"
                );
            }
            let view = panel["view"]
                .as_str()
                .unwrap_or_else(|| panic!("{extension_id}/{panel_id}: panel has no view"));
            // Catalog panels are data-only: a `self:` view needs renderer code, which a
            // release-managed extension never carries.
            assert!(
                view == "auto" || view.starts_with("builtin:"),
                "{extension_id}/{panel_id}: panel view `{view}` must be auto or builtin:*"
            );
            let mut built =
                json!({"id": panel_id, "title": title, "source": panel["source"], "view": view});
            if let Some(config) = panel.get("config") {
                built["config"] = config.clone();
            }
            built
        })
        .collect()
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

    #[test]
    fn every_shipped_template_declares_valid_panels() {
        // build() asserts its way through each declared panel, so constructing the whole
        // catalog IS the check: a template that names an unknown verb or an unsafe path
        // fails here rather than at request time. Shipping zero panels is fine; shipping
        // a malformed one is not.
        for extension in list() {
            let panels = extension["panels"]
                .as_array()
                .expect("every summary carries a panels array");
            for panel in panels {
                assert!(panel["id"].is_string());
                assert!(panel["title"].is_string());
                assert!(PANEL_SOURCE_KINDS.contains(&panel["source"]["kind"].as_str().unwrap()));
            }
        }
    }

    #[test]
    fn a_template_panel_reaches_the_summary() {
        let built = build(
            &json!({
                "id": "demo", "version": 1, "title": "Demo",
                "views": [{"id": "notes", "title": "Notes", "file": "notes.md", "lens": "markdown"}],
                "seed": {"notes.md": "hi"},
                "panels": [{
                    "id": "roster", "title": "Roster",
                    "source": {"kind": "resource", "verb": "channel.members"},
                    "view": "builtin:table"
                }]
            })
            .to_string(),
        );
        let panels = built.summary["panels"].as_array().unwrap();
        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0]["id"], "roster");
        assert_eq!(panels[0]["source"]["verb"], "channel.members");
        assert_eq!(panels[0]["view"], "builtin:table");
    }

    #[test]
    fn a_template_without_panels_still_builds() {
        let built = build(
            &json!({
                "id": "plain", "version": 1, "title": "Plain",
                "views": [{"id": "notes", "title": "Notes", "file": "notes.md", "lens": "markdown"}],
                "seed": {"notes.md": "hi"}
            })
            .to_string(),
        );
        assert_eq!(built.summary["panels"], json!([]));
    }

    // The catalog is a second way to DECLARE a panel, never a second grammar. These are
    // the same refusals the package installers make; a template that could smuggle past
    // them would make the vocabulary meaningless.

    #[test]
    fn the_shipped_roster_panel_unwraps_its_wrapper() {
        // The one shipped panel, and the proof `pick` is load-bearing: channel.members
        // answers {members: [...]} while builtin:table wants the bare array, so without
        // `pick` this board renders empty.
        let team_ops = list()
            .into_iter()
            .find(|e| e["id"] == "cheers-team-ops")
            .expect("team ops ships");
        let roster = &team_ops["panels"][0];
        assert_eq!(roster["id"], "roster");
        assert_eq!(roster["source"]["verb"], "channel.members");
        assert_eq!(roster["source"]["pick"], "members");
        assert_eq!(roster["view"], "builtin:table");
        // Columns, or the table infers every member key and reads as debug output.
        assert!(roster["config"]["columns"]
            .as_array()
            .is_some_and(|c| !c.is_empty()));
    }

    #[test]
    #[should_panic(expected = "pick must be a key name")]
    fn a_template_cannot_pick_with_a_non_key() {
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "r", "title": "R",
                    "source": {"kind": "resource", "verb": "channel.members", "pick": 3},
                    "view": "builtin:table"}]
            })
            .to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "no wrapper to pick from")]
    fn an_fs_template_panel_cannot_pick() {
        // A file source hands back content, not a wrapper; accepting `pick` would let a
        // template say something the reader silently ignores.
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "r", "title": "R",
                    "source": {"kind": "fs", "path": "ops/servers.yaml", "pick": "rows"},
                    "view": "builtin:table"}]
            })
            .to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "is not one of")]
    fn a_template_cannot_reach_a_bot_machine() {
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "repo", "title": "Repo",
                    "source": {"kind": "workspace", "botId": "b1", "path": "src"},
                    "view": "builtin:table"}]
            })
            .to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "not an allowed channel resource")]
    fn a_template_cannot_widen_the_resource_vocabulary() {
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "s", "title": "S",
                    "source": {"kind": "resource", "verb": "channel.secrets"},
                    "view": "builtin:table"}]
            })
            .to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "must be auto or builtin:")]
    fn a_template_cannot_name_renderer_code() {
        // Release-managed extensions carry no renderer bundle, so `self:` has nothing to
        // resolve against.
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "c", "title": "C",
                    "source": {"kind": "resource", "verb": "channel.info"},
                    "view": "self:chart"}]
            })
            .to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "unsafe workspace path")]
    fn a_template_cannot_escape_the_workspace() {
        build(
            &json!({
                "id": "bad", "version": 1, "title": "Bad",
                "views": [{"id": "n", "title": "N", "file": "n.md", "lens": "markdown"}],
                "seed": {"n.md": "x"},
                "panels": [{"id": "e", "title": "E",
                    "source": {"kind": "fs", "path": "../../etc/passwd"},
                    "view": "builtin:table"}]
            })
            .to_string(),
        );
    }
}
