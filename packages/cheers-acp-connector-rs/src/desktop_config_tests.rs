//! Exercise the desktop's actual Host config producer with the real connector
//! loader. These tests only read synthetic credentials and never run an agent.

#[path = "../../../apps/macos/src-tauri/src/host_config.rs"]
mod desktop_host_config;

use crate::config::load_config;

fn gateway_config(workspace: &std::path::Path) -> String {
    format!(
        r#"version = 1
[daemon]
state_path = "state.json"
log_dir = "logs"
[accounts.helper.bridge]
control_url = "ws://127.0.0.1:1/control"
data_url = "ws://127.0.0.1:1/data"
host_credential_file = "secrets/helper.token"
[accounts.helper.adapter]
type = "stdio"
command = "/usr/bin/true"
args = []
[accounts.helper.policy.workspace]
default_cwd = {workspace}
allowed_roots = [{workspace}]
remote_open = false
remote_terminal = false
"#,
        workspace = serde_json::to_string(&workspace.to_string_lossy()).unwrap(),
    )
}

#[tokio::test]
async fn desktop_host_configs_load_with_isolated_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("secrets")).unwrap();
    let source = gateway_config(&root);
    for (name, credential) in [
        ("helper-host-one", "host-one"),
        ("helper-host-two", "host-two"),
    ] {
        let (generated, credential_file) =
            desktop_host_config::scope_host_instance(&source, "helper", name).unwrap();
        std::fs::write(root.join(&credential_file), credential).unwrap();
        let path = root.join(format!("{name}.toml"));
        std::fs::write(&path, generated).unwrap();
        let config = load_config(&path).await.unwrap();
        assert_eq!(config.accounts["helper"].bridge_credential, credential);
        assert_eq!(config.state_path, root.join(format!("state-{name}.json")));
        assert_eq!(config.log_dir, Some(root.join(format!("logs-{name}"))));
        assert!(!config.accounts["helper"].policy.workspace.remote_open);
        assert!(!config.accounts["helper"].policy.workspace.remote_terminal);
    }
    assert!(!root.join("secrets/helper.token").exists());
}

#[tokio::test]
async fn retry_repairs_the_desktop_042_config_without_shared_credential_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("secrets")).unwrap();
    let (generated, credential_file) = desktop_host_config::scope_host_instance(
        &gateway_config(&root),
        "helper",
        "helper-host-one",
    )
    .unwrap();
    std::fs::write(root.join(&credential_file), "host-one").unwrap();
    let mut broken: toml_edit::DocumentMut = generated.parse().unwrap();
    broken["accounts"]["helper"]["bridge"]["host_credential_file"] =
        toml_edit::value("secrets/helper.token");
    broken["accounts"]["helper"]["bridge"]["token_file"] =
        toml_edit::value(credential_file.as_str());
    let path = root.join("helper-host-one.toml");
    std::fs::write(&path, broken.to_string()).unwrap();
    let error = format!("{:#}", load_config(&path).await.unwrap_err());
    assert!(error.contains("unknown field `token_file`"), "{error}");

    let repaired =
        desktop_host_config::repair_desktop_host_credential(&broken.to_string()).unwrap();
    assert_eq!(
        desktop_host_config::repair_desktop_host_credential(&repaired).unwrap(),
        repaired
    );
    std::fs::write(&path, repaired).unwrap();
    let config = load_config(&path).await.unwrap();
    assert_eq!(config.accounts["helper"].bridge_credential, "host-one");
    assert!(!root.join("secrets/helper.token").exists());

    // A missing host credential must fail rather than silently binding this
    // host to another instance's original account credential.
    std::fs::remove_file(root.join(&credential_file)).unwrap();
    std::fs::write(root.join("secrets/helper.token"), "another-host").unwrap();
    assert!(load_config(&path).await.is_err());
}
