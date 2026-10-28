//! Exercise a gateway-rendered fixture through the desktop's production writer
//! and the real connector loader. All files are temporary; no agent is started
//! and no bridge socket is opened.

#[path = "../../../apps/macos/src-tauri/src/host_config.rs"]
mod desktop_host_config;

use crate::config::load_config;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

#[derive(serde::Deserialize)]
struct GatewayFixture {
    account_id: String,
    credential_file: String,
    config_toml: String,
}

fn gateway_config(root: &Path) -> GatewayFixture {
    // The gateway test checks these bytes against its actual render_toml; this
    // test does not maintain a second, handwritten version of that schema.
    let mut fixture: GatewayFixture = serde_json::from_str(include_str!(
        "../../../fixtures/desktop-onboarding/gateway-codex.json"
    ))
    .unwrap();
    let command = root.join("adapter-not-started");
    let marker = root.join("adapter-was-started");
    fs::write(
        &command,
        format!(
            "#!/bin/sh\nprintf unexpected > '{}'\nexit 91\n",
            marker.to_string_lossy().replace('\'', "'\\''")
        ),
    )
    .unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config: toml_edit::DocumentMut = fixture.config_toml.parse().unwrap();
    config["accounts"][fixture.account_id.as_str()]["adapter"]["command"] =
        toml_edit::value(command.to_string_lossy().as_ref());
    fixture.config_toml = config.to_string();
    fixture
}

#[tokio::test]
async fn gateway_template_desktop_write_and_connector_load_are_one_contract() {
    let directory = tempfile::Builder::new()
        .prefix("cheers-desktop-onboarding-")
        .tempdir()
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    let base = root.join("isolated-home/.cheers");
    let project = root.join("selected-project");
    fs::create_dir(&project).unwrap();
    let fixture = gateway_config(&root);
    for (name, credential) in [
        ("e2e-codex-host-one", "host-one"),
        ("e2e-codex-host-two", "host-two"),
    ] {
        let path = desktop_host_config::write_onboarded_host_config(
            &base,
            &fixture.account_id,
            &fixture.config_toml,
            &format!(" {credential}\n"),
            &fixture.credential_file,
            Some(name),
            Some(&project),
        )
        .unwrap();
        assert_eq!(path, base.join(format!("cheers-daemon.{name}.toml")));
        let config = load_config(&path).await.unwrap();
        let account = &config.accounts[&fixture.account_id];
        assert_eq!(account.bridge_credential, credential);
        assert_eq!(config.state_path, base.join(format!("state-{name}.json")));
        assert_eq!(config.log_dir, Some(base.join(format!("logs-{name}"))));
        assert_eq!(
            account.policy.workspace.default_cwd.as_deref(),
            Some(project.as_path())
        );
        assert_eq!(
            account.policy.workspace.allowed_roots,
            vec![project.clone()]
        );
        assert!(!account.policy.workspace.remote_open);
        assert!(!account.policy.workspace.remote_terminal);
        assert_eq!(
            account.control_url,
            "ws://127.0.0.1:1/ws/agent-bridge/control"
        );
        assert_eq!(account.data_url, "ws://127.0.0.1:1/ws/agent-bridge/data");
        let credential_path = base.join(format!("secrets/{name}.token"));
        assert_eq!(fs::read_to_string(&credential_path).unwrap(), credential);
        assert_eq!(
            fs::metadata(&credential_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let persisted: toml_edit::DocumentMut = fs::read_to_string(&path).unwrap().parse().unwrap();
        assert!(persisted["accounts"][fixture.account_id.as_str()]["bridge"]
            .get("token_file")
            .is_none());
    }
    assert!(!base.join(&fixture.credential_file).exists());

    // The account-named onboarding entry point also uses the same writer.
    let account_path = desktop_host_config::write_onboarded_host_config(
        &base,
        &fixture.account_id,
        &fixture.config_toml,
        "account-host",
        &fixture.credential_file,
        None,
        Some(&project),
    )
    .unwrap();
    let account_config = load_config(&account_path).await.unwrap();
    assert_eq!(
        account_config.accounts[&fixture.account_id].bridge_credential,
        "account-host"
    );
    assert_eq!(
        fs::read_to_string(base.join("secrets/e2e-codex-host-one.token")).unwrap(),
        "host-one"
    );
    assert!(!root.join("adapter-was-started").exists());
}

#[tokio::test]
async fn retry_repairs_the_desktop_042_config_without_shared_credential_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let fixture = gateway_config(&root);
    let path = desktop_host_config::write_onboarded_host_config(
        &root,
        &fixture.account_id,
        &fixture.config_toml,
        "host-one",
        &fixture.credential_file,
        Some("codex-host-one"),
        Some(&root),
    )
    .unwrap();
    let credential_file = "secrets/codex-host-one.token";
    let mut broken: toml_edit::DocumentMut = fs::read_to_string(&path).unwrap().parse().unwrap();
    broken["accounts"][fixture.account_id.as_str()]["bridge"]["host_credential_file"] =
        toml_edit::value(fixture.credential_file.as_str());
    broken["accounts"][fixture.account_id.as_str()]["bridge"]["token_file"] =
        toml_edit::value(credential_file);
    fs::write(&path, broken.to_string()).unwrap();
    let error = format!("{:#}", load_config(&path).await.unwrap_err());
    assert!(error.contains("unknown field `token_file`"), "{error}");

    let repaired =
        desktop_host_config::repair_desktop_host_credential(&broken.to_string()).unwrap();
    assert_eq!(
        desktop_host_config::repair_desktop_host_credential(&repaired).unwrap(),
        repaired
    );
    fs::write(&path, repaired).unwrap();
    let config = load_config(&path).await.unwrap();
    assert_eq!(
        config.accounts[&fixture.account_id].bridge_credential,
        "host-one"
    );
    assert!(!root.join(&fixture.credential_file).exists());

    // A missing host credential must fail rather than silently binding this
    // host to another instance's original account credential.
    fs::remove_file(root.join(credential_file)).unwrap();
    fs::write(root.join(&fixture.credential_file), "another-host").unwrap();
    assert!(load_config(&path).await.is_err());
    assert!(!root.join("adapter-was-started").exists());
}

#[test]
fn invalid_onboarding_never_writes_credentials_or_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let fixture = gateway_config(&root);
    let base = root.join("uncreated-home/.cheers");
    for (config, credential_file, project, credential) in [
        (
            fixture.config_toml.clone(),
            "../outside.token",
            Some(root.as_path()),
            "credential",
        ),
        (
            fixture.config_toml.clone(),
            "/outside.token",
            Some(root.as_path()),
            "credential",
        ),
        (
            fixture.config_toml.clone(),
            "secrets/other.token",
            Some(root.as_path()),
            "credential",
        ),
        (
            fixture.config_toml.clone(),
            fixture.credential_file.as_str(),
            Some(Path::new("relative/project")),
            "credential",
        ),
        (
            fixture.config_toml.clone(),
            fixture.credential_file.as_str(),
            Some(root.as_path()),
            "  ",
        ),
        (
            fixture
                .config_toml
                .replace("host_credential_file", "host_credential_env"),
            fixture.credential_file.as_str(),
            Some(root.as_path()),
            "credential",
        ),
    ] {
        assert!(desktop_host_config::write_onboarded_host_config(
            &base,
            &fixture.account_id,
            &config,
            credential,
            credential_file,
            None,
            project,
        )
        .is_err());
        assert!(!base.exists());
    }
    assert!(!root.join("outside.token").exists());
    assert!(!root.join("adapter-was-started").exists());
}
