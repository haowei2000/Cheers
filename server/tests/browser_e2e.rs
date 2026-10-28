//! Real browser registration and Home creation against the existing PG fixture.
#![cfg(feature = "integration")]

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

/// Own only the browser launcher's new process group. Playwright manages its
/// browser/webServer descendants; its global timeout expires before this outer
/// fixture watchdog so normal failure cleanup can finish first.
#[cfg(unix)]
struct BrowserProcess {
    child: Child,
}

#[cfg(unix)]
impl BrowserProcess {
    fn start(command: &mut Command) -> Self {
        use std::os::unix::process::CommandExt;
        Self {
            child: command.process_group(0).spawn().expect("start Playwright"),
        }
    }

    async fn wait(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll Playwright") {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Playwright exceeded the bounded browser fixture timeout"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[cfg(unix)]
impl Drop for BrowserProcess {
    fn drop(&mut self) {
        let group = format!("-{}", self.child.id());
        let signal = |name: &str| {
            let _ = Command::new("/bin/kill")
                .args([name, "--", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        };
        signal("-TERM");
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        // A failed browser launcher can exit before its webServer. Kill the
        // remainder of this same owned group even after its leader has exited.
        signal("-KILL");
        let _ = self.child.wait();
    }
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn desktop_onboarding_fixture_matches_gateway_renderer() {
    use server::domain::connector_config::{render_toml, RenderParams, TokenRef};

    let expected = json!({
        "account_id":"e2e-codex",
        "credential_file":"secrets/e2e-codex.token",
        "config_toml":render_toml(&RenderParams {
            account_id:"e2e-codex",
            agent_type:"codex",
            public_base:"ws://127.0.0.1:1",
            token_ref:TokenRef::HostFile("secrets/e2e-codex.token".into()),
        }),
    });
    let path = repository_root().join("fixtures/desktop-onboarding/gateway-codex.json");
    if std::env::var("UPDATE_DESKTOP_ONBOARDING_FIXTURE").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&expected).unwrap()),
        )
        .unwrap();
    }
    let actual: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect(
        "committed renderer fixture; explicitly regenerate with UPDATE_DESKTOP_ONBOARDING_FIXTURE=1",
    ))
    .unwrap();
    assert_eq!(
        actual, expected,
        "desktop fixture must track the real gateway renderer"
    );
}

#[cfg(unix)]
#[sqlx::test]
#[ignore = "opt-in real browser: make test-e2e uses --include-ignored"]
async fn ordinary_user_registration_and_personal_channels_in_real_browser(db: PgPool) {
    // Vite's official Playwright webServer uses strictPort; a collision fails
    // this test rather than connecting to an unrelated existing application.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let frontend_address = listener.local_addr().unwrap();
    let origin = format!("http://{frontend_address}");
    let (gateway, base) = gateway::TestGateway::start_browser_e2e(
        &db,
        "browser-fixture-admin",
        &Uuid::new_v4().to_string(),
        &origin,
    )
    .await;
    drop(listener);
    let suffix = Uuid::new_v4().simple().to_string();
    let login = format!("browser-{suffix}");
    let email = format!("{login}@e2e.invalid");
    let password = format!("Browser-{}!", Uuid::new_v4());
    // No ordinary user, email code, workspace, or membership is inserted here.
    let existing: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username=$1 OR email=$2")
            .bind(&login)
            .bind(&email)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(existing, 0);
    let frontend = repository_root().join("frontend");
    let mut command = Command::new("pnpm");
    command
        .args(["--dir"])
        .arg(&frontend)
        .args([
            "exec",
            "playwright",
            "test",
            "--config",
            "playwright.config.ts",
        ])
        .current_dir(repository_root())
        .env("INTEGRATION_BASE_URL", &origin)
        .env("E2E_GATEWAY_URL", &base)
        .env("E2E_USER_LOGIN", &login)
        .env("E2E_USER_PASSWORD", &password)
        .env("E2E_USER_EMAIL", &email)
        .env("CHEERS_E2E_GATEWAY_LOG", gateway.log_path())
        .stdin(Stdio::null());
    let mut browser = BrowserProcess::start(&mut command);
    // Cover Playwright's bounded 180s webServer startup plus the 90s scenario.
    let status = browser.wait(Duration::from_secs(360)).await;
    drop(browser);
    assert!(
        status.success(),
        "real browser verification failed: {status}"
    );
    let _released_frontend = std::net::TcpListener::bind(frontend_address)
        .expect("Playwright must release its owned Vite port after the run");

    // Ensure the UI registered an ordinary identity, rather than accidentally
    // logging in as the bootstrap administrator or using seeded authority.
    let (user, role): (String, String) =
        sqlx::query_as("SELECT user_id,role FROM users WHERE username=$1 AND email=$2")
            .bind(&login)
            .bind(&email)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(role, "member");
    let (workspace, member_role, member_status): (String, String, String) = sqlx::query_as(
        "SELECT w.workspace_id,wm.role,wm.status FROM workspaces w JOIN workspace_memberships wm ON wm.workspace_id=w.workspace_id AND wm.user_id=w.owner_user_id WHERE w.kind='personal' AND w.owner_user_id=$1",
    )
    .bind(&user).fetch_one(&db).await.unwrap();
    assert_eq!(
        (member_role.as_str(), member_status.as_str()),
        ("owner", "active")
    );
    let created: (bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM channels c JOIN channel_memberships cm ON cm.channel_id=c.channel_id WHERE c.workspace_id=$1 AND c.type='public' AND cm.member_id=$2 AND cm.member_type='user' AND cm.role='owner'),EXISTS(SELECT 1 FROM channels c JOIN channel_memberships cm ON cm.channel_id=c.channel_id WHERE c.workspace_id=$1 AND c.type='private' AND cm.member_id=$2 AND cm.member_type='user' AND cm.role='owner')",
    )
    .bind(&workspace).bind(&user).fetch_one(&db).await.unwrap();
    assert_eq!(created, (true, true));
}
