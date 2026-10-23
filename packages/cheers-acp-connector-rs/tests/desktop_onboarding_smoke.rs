//! Run the desktop onboarding files with the actual connector executable.
//!
//! Release validation sets CHEERS_CONNECTOR_SMOKE_BINARY to the just-built
//! bundle's sidecar. Ordinary Cargo integration tests use Cargo's real binary.
//! Only an initialize-only Python fixture and loopback bridge are used: no
//! installed agent, existing connector, production credential, or user HOME.

#[path = "../../../apps/macos/src-tauri/src/host_config.rs"]
mod desktop_host_config;

use cheers_bridge_protocol::{
    AgentBridgeAuth, ControlInbound, ControlOutbound, DataInbound, BRIDGE_PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, File},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
    WebSocketStream,
};

const CREDENTIAL: &str = "agbi_desktop_onboarding_synthetic_fixture_only";
const AGENT_NAME: &str = "desktop-onboarding-initialize-only-fixture";
const INITIALIZE_ONLY: &str = r#"
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    with open(sys.argv[1], 'a', encoding='utf-8') as journal:
        journal.write(json.dumps({'method': method}) + '\n')
    if method != 'initialize' or 'id' not in request:
        sys.exit(91)
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {
        'protocolVersion': request['params']['protocolVersion'],
        'agentCapabilities': {'loadSession': False,
            'mcpCapabilities': {'http': True}},
        'agentInfo': {'name': 'desktop-onboarding-initialize-only-fixture', 'version': '1'},
        'authMethods': []}}), flush=True)
"#;

#[derive(Deserialize)]
struct GatewayFixture {
    account_id: String,
    credential_file: String,
    config_toml: String,
}

fn connector_binary() -> PathBuf {
    env::var_os("CHEERS_CONNECTOR_SMOKE_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_cce-acp-connector")))
        .canonicalize()
        .expect("the source binary or explicit release sidecar must exist")
}

fn python_binary() -> PathBuf {
    env::split_paths(&env::var_os("PATH").expect("Python 3 must be available on PATH"))
        .map(|directory| directory.join("python3"))
        .find(|candidate| {
            candidate.is_file()
                && fs::metadata(candidate)
                    .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        })
        .expect("install/provide Python 3 for the isolated initialize-only fixture")
        .canonicalize()
        .expect("resolve the existing Python interpreter to an absolute path")
}

/// Own the complete temporary process group, including its synthetic ACP child.
/// Panic/timeout cleanup never addresses another daemon or an installed app.
struct OwnedConnector {
    child: Child,
    group_id: i32,
    stdout: PathBuf,
    stderr: PathBuf,
}

impl OwnedConnector {
    fn start(binary: &Path, root: &Path, config: &Path, label: &str) -> Self {
        let stdout = root.join(format!("{label}.stdout.log"));
        let stderr = root.join(format!("{label}.stderr.log"));
        let home = root.join("isolated-home");
        let mut command = Command::new(binary);
        command
            .arg("--config")
            .arg(config)
            .arg("run")
            .current_dir(root)
            .env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("TMPDIR", root)
            .env("PATH", "/usr/bin:/bin")
            .env("CHEERS_ACP_HOME", home.join(".cheers/acp-connector"))
            .env("CHEERS_ACP_NO_SELF_UPDATE", "1")
            .env("RUST_LOG", "cce_acp_connector=info")
            .stdin(Stdio::null())
            .stdout(Stdio::from(File::create(&stdout).unwrap()))
            .stderr(Stdio::from(File::create(&stderr).unwrap()))
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let child = command
            .spawn()
            .expect("launch only the selected connector binary");
        let group_id = i32::try_from(child.id().unwrap()).unwrap();
        Self {
            child,
            group_id,
            stdout,
            stderr,
        }
    }

    fn signal_group(&self, signal: i32) {
        // The child established its own process group at spawn; both the
        // connector and the only permitted Python fixture belong to this group.
        unsafe {
            libc::kill(-self.group_id, signal);
        }
    }

    fn logs(&self) -> String {
        format!(
            "{}\n{}",
            fs::read_to_string(&self.stdout).unwrap_or_default(),
            fs::read_to_string(&self.stderr).unwrap_or_default(),
        )
    }

    async fn wait_for_rejection(&mut self) -> ExitStatus {
        timeout(Duration::from_secs(15), self.child.wait())
            .await
            .unwrap_or_else(|_| panic!("invalid config did not exit promptly:\n{}", self.logs()))
            .unwrap()
    }

    async fn stop(&mut self) {
        self.signal_group(libc::SIGTERM);
        match timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(status) => {
                status.expect("reap the test-owned connector after SIGTERM");
            }
            Err(_) => {
                self.signal_group(libc::SIGKILL);
                timeout(Duration::from_secs(5), self.child.wait())
                    .await
                    .expect("reap the test-owned connector after SIGKILL")
                    .unwrap();
            }
        }
    }
}

impl Drop for OwnedConnector {
    fn drop(&mut self) {
        self.signal_group(libc::SIGKILL);
        let _ = self.child.start_kill();
    }
}

async fn accept_bridge(listener: &TcpListener, path: &str) -> WebSocketStream<TcpStream> {
    let (stream, peer) = listener.accept().await.unwrap();
    assert!(peer.ip().is_loopback());
    let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), path);
        Ok(response)
    })
    .await
    .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    let Message::Text(text) = message else {
        panic!("expected the first-frame bridge authentication message");
    };
    let auth: AgentBridgeAuth = serde_json::from_str(&text).unwrap();
    assert_eq!(auth.frame_type, "auth");
    assert_eq!(auth.v, BRIDGE_PROTOCOL_VERSION);
    assert_eq!(auth.bridge_protocol_version, BRIDGE_PROTOCOL_VERSION);
    assert_eq!(auth.token, CREDENTIAL);
    socket
}

async fn send_frame(socket: &mut WebSocketStream<TcpStream>, frame: impl serde::Serialize) {
    socket
        .send(Message::Text(serde_json::to_string(&frame).unwrap()))
        .await
        .unwrap();
}

async fn control_frame(socket: &mut WebSocketStream<TcpStream>) -> ControlOutbound {
    loop {
        match socket
            .next()
            .await
            .expect("connector socket remains open")
            .unwrap()
        {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            other => panic!("unexpected connector frame: {other:?}"),
        }
    }
}

#[tokio::test]
async fn desktop_onboarding_files_work_with_the_actual_connector_binary() {
    let directory = tempfile::Builder::new()
        .prefix("cheers-desktop-binary-smoke-")
        .tempdir()
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    let base = root.join("isolated-home/.cheers");
    let workspace = root.join("selected-project");
    fs::create_dir(&workspace).unwrap();
    let binary = connector_binary();
    let python = python_binary();
    let script = root.join("initialize_only.py");
    let journal = root.join("synthetic-agent-calls.jsonl");
    fs::write(&script, INITIALIZE_ONLY).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture: GatewayFixture = serde_json::from_str(include_str!(
        "../../../fixtures/desktop-onboarding/gateway-codex.json"
    ))
    .unwrap();
    let mut source: toml_edit::DocumentMut = fixture.config_toml.parse().unwrap();
    let account = &mut source["accounts"][fixture.account_id.as_str()];
    account["bridge"]["control_url"] =
        toml_edit::value(format!("ws://{address}/ws/agent-bridge/control"));
    account["bridge"]["data_url"] =
        toml_edit::value(format!("ws://{address}/ws/agent-bridge/data"));
    account["adapter"]["command"] = toml_edit::value(python.to_string_lossy().as_ref());
    let mut args = toml_edit::Array::new();
    for arg in [
        "-I",
        "-u",
        script.to_str().unwrap(),
        journal.to_str().unwrap(),
    ] {
        args.push(arg);
    }
    account["adapter"]["args"] = toml_edit::value(args);
    source["update"] = toml_edit::Item::Table(toml_edit::Table::new());
    source["update"]["auto"] = toml_edit::value(false);
    let path = desktop_host_config::write_onboarded_host_config(
        &base,
        &fixture.account_id,
        &source.to_string(),
        CREDENTIAL,
        &fixture.credential_file,
        Some("desktop-binary-smoke"),
        Some(&workspace),
    )
    .unwrap();
    let mut broken: toml_edit::DocumentMut = fs::read_to_string(&path).unwrap().parse().unwrap();
    broken["accounts"][fixture.account_id.as_str()]["bridge"]["token_file"] =
        toml_edit::value("secrets/desktop-binary-smoke.token");
    let broken_path = base.join("unknown-token-file.toml");
    fs::write(&broken_path, broken.to_string()).unwrap();
    let mut rejected = OwnedConnector::start(&binary, &root, &broken_path, "invalid-config");
    assert!(!rejected.wait_for_rejection().await.success());
    let rejected_logs = rejected.logs();
    assert!(
        rejected_logs.contains("unknown field `token_file`"),
        "{rejected_logs}"
    );
    assert!(
        !rejected_logs.contains("validated connector config"),
        "{rejected_logs}"
    );
    assert!(
        !journal.exists(),
        "invalid config must not start even the synthetic fixture"
    );
    drop(rejected);

    let mut connector = OwnedConnector::start(&binary, &root, &path, "valid-config");
    let handshake = timeout(Duration::from_secs(20), async {
        let mut control = accept_bridge(&listener, "/ws/agent-bridge/control").await;
        send_frame(
            &mut control,
            ControlInbound::Hello {
                v: BRIDGE_PROTOCOL_VERSION,
                bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
                stream: Some("control".into()),
                bot_id: "11111111-1111-4111-8111-111111111111".into(),
                host_id: Some("22222222-2222-4222-8222-222222222222".into()),
                bot_username: fixture.account_id.clone(),
                bot_display_name: None,
                connection_id: Some("control-smoke".into()),
                session_id: "control-session-smoke".into(),
                memberships: Vec::new(),
                acp_security: None,
                connector_config: None,
                server_capabilities: None,
                mcp_url: Some(format!("http://{address}/mcp")),
            },
        )
        .await;
        match control_frame(&mut control).await {
            ControlOutbound::Ready {
                v,
                connector_version,
                runtime,
                connector_capabilities,
                ..
            } => {
                assert_eq!(v, BRIDGE_PROTOCOL_VERSION);
                assert_eq!(
                    connector_version.as_deref(),
                    Some(env!("CARGO_PKG_VERSION"))
                );
                let runtime =
                    runtime.expect("actual ACP initialization supplies the runtime descriptor");
                assert_eq!(runtime.protocol, "acp");
                assert_eq!(runtime.name.as_deref(), Some(AGENT_NAME));
                let capabilities = connector_capabilities.unwrap();
                assert_eq!(capabilities["task_acceptance"], true);
                assert_eq!(capabilities["terminal_replay"], true);
            }
            frame => panic!("expected real Ready after ACP initialize, got {frame:?}"),
        }
        let mut data = accept_bridge(&listener, "/ws/agent-bridge/data").await;
        send_frame(
            &mut data,
            DataInbound::Hello {
                v: BRIDGE_PROTOCOL_VERSION,
                bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
                stream: "data".into(),
                bot_id: "11111111-1111-4111-8111-111111111111".into(),
                host_id: Some("22222222-2222-4222-8222-222222222222".into()),
                connection_id: Some("data-smoke".into()),
                session_id: "data-session-smoke".into(),
                last_event_seq: 0,
                acp_security: None,
                server_capabilities: None,
            },
        )
        .await;
        let revision = json!("desktop-artifact-onboarding-smoke");
        send_frame(
            &mut control,
            ControlInbound::ConfigUpdate {
                v: BRIDGE_PROTOCOL_VERSION,
                revision: Some(revision.clone()),
                settings: None,
                updated_at: None,
            },
        )
        .await;
        match control_frame(&mut control).await {
            ControlOutbound::ConfigStatus {
                v,
                revision: actual,
                ok,
                applied,
                rejected,
            } => {
                assert_eq!(v, BRIDGE_PROTOCOL_VERSION);
                assert_eq!(actual, Some(revision));
                assert!(ok);
                assert!(applied.is_empty());
                assert!(rejected.is_empty());
            }
            frame => panic!("expected runtime config_status proof, got {frame:?}"),
        }
        // Keep both test-owned sockets alive until the correlated runtime ACK.
        (control, data)
    })
    .await;
    assert!(
        handshake.is_ok(),
        "actual binary did not finish the local handshake:\n{}",
        connector.logs()
    );
    connector.stop().await;
    drop(handshake);
    let logs = connector.logs();
    assert!(logs.contains("validated connector config"), "{logs}");
    assert!(logs.contains("Rust BridgeRuntime started"), "{logs}");
    let calls: Vec<Value> = fs::read_to_string(&journal)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        calls,
        vec![json!({"method":"initialize"})],
        "only the temporary initialize fixture may run; no sessions or prompts"
    );
}
