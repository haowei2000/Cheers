//! Runs with the existing Postgres integration suite. sqlx creates and migrates
//! an isolated database; this test starts its own gateway on a temporary port.
//! DATABASE_URL=postgres://... cargo test --features integration --test annotations_http
#![cfg(feature = "integration")]
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::{ConnectOptions, PgPool};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use uuid::Uuid;

/// Own the process and temporary keys even if an assertion panics.
struct TestGateway {
    process: Option<Child>,
    directory: PathBuf,
}
impl Drop for TestGateway {
    fn drop(&mut self) {
        if let Some(process) = self.process.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl TestGateway {
    async fn start(db: &PgPool, login: &str, password: &str) -> (Self, String) {
        let directory = std::env::temp_dir().join(format!("cheers-annotations-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut gateway = Self {
            process: None,
            directory,
        };
        let private = gateway.directory.join("private.pem");
        let public = gateway.directory.join("public.pem");
        for args in [
            vec![
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
                "-out",
                private.to_str().unwrap(),
            ],
            vec![
                "pkey",
                "-in",
                private.to_str().unwrap(),
                "-pubout",
                "-out",
                public.to_str().unwrap(),
            ],
        ] {
            let output = Command::new("openssl")
                .args(args)
                .output()
                .expect("openssl is required for temporary test keys");
            assert!(output.status.success(), "temporary key generation failed");
        }
        // Ask the OS for a free port rather than assume one shared by other stacks.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let base = format!("http://127.0.0.1:{port}");
        let log = std::fs::File::create(gateway.directory.join("gateway.log")).unwrap();
        gateway.process = Some(
            Command::new(env!("CARGO_BIN_EXE_server"))
                .current_dir(&gateway.directory)
                .env("DATABASE_URL", db.connect_options().to_url_lossy().as_str())
                .env("PORT", port.to_string())
                .env("JWT_PRIVATE_KEY", std::fs::read_to_string(private).unwrap())
                .env("JWT_PUBLIC_KEY", std::fs::read_to_string(public).unwrap())
                .env("ADMIN_USERNAME", login)
                .env("ADMIN_PASSWORD", password)
                .env("S3_ENDPOINT", "http://127.0.0.1:1")
                .env("S3_ACCESS_KEY", "integration-test")
                .env("S3_SECRET_KEY", "integration-test")
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let exited = gateway.process.as_mut().unwrap().try_wait().unwrap();
            assert!(
                exited.is_none(),
                "test gateway exited: {:?}\n{}",
                exited,
                std::fs::read_to_string(gateway.directory.join("gateway.log")).unwrap()
            );
            if client
                .get(format!("{base}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "test gateway did not become ready\n{}",
                std::fs::read_to_string(gateway.directory.join("gateway.log")).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        (gateway, base)
    }
}

async fn request(
    client: &Client,
    base: &str,
    token: &str,
    method: Method,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = client
        .request(method, format!("{base}/api/v1{path}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value = response.json().await.unwrap();
    (status, value)
}
async fn login(client: &Client, base: &str, login: &str, password: &str) -> Value {
    let (status, body) = request(
        client,
        base,
        "",
        Method::POST,
        "/auth/login",
        json!({"login":login,"password":password}),
    )
    .await;
    assert!(status.is_success(), "login failed: {body}");
    body
}
#[sqlx::test]
async fn file_and_event_annotations_are_durable_scoped_and_conflict_safe(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = TestGateway::start(&db, "annotation-test-admin", &password).await;
    check_annotations(db, base, "annotation-test-admin", password).await;
}

/// Optional smoke test against an already running isolated stack. The default
/// CI test above runs these same assertions using its own database and gateway.
#[tokio::test]
#[ignore = "external stack: set INTEGRATION_BASE_URL, DATABASE_URL, INTEGRATION_LOGIN and INTEGRATION_PASSWORD"]
async fn external_gateway_annotations() {
    let base = std::env::var("INTEGRATION_BASE_URL").expect("INTEGRATION_BASE_URL");
    let db = PgPool::connect(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .await
        .unwrap();
    let username = std::env::var("INTEGRATION_LOGIN").expect("INTEGRATION_LOGIN");
    let password = std::env::var("INTEGRATION_PASSWORD").expect("INTEGRATION_PASSWORD");
    check_annotations(db, base, &username, password).await;
}

async fn check_annotations(db: PgPool, base: String, username: &str, password: String) {
    let client = Client::new();
    let auth = login(&client, &base, username, &password).await;
    let token = auth["access_token"].as_str().unwrap();
    let owner = auth["user_id"].as_str().unwrap();
    let (status, ws) = request(
        &client,
        &base,
        token,
        Method::POST,
        "/workspaces",
        json!({"name":"Annotation integration"}),
    )
    .await;
    assert!(status.is_success(), "{ws}");
    let workspace = ws["workspace_id"].as_str().unwrap();
    let (status, ch) = request(
        &client,
        &base,
        token,
        Method::POST,
        "/channels",
        json!({"workspace_id":workspace,"name":format!("annotation-{}",Uuid::new_v4())}),
    )
    .await;
    assert!(status.is_success(), "{ch}");
    let channel = ch["channel_id"].as_str().unwrap();
    let path = format!("/channels/{channel}/annotations");
    let (status,note)=request(&client,&base,token,Method::POST,&path,json!({"target":{"kind":"file","path":"docs/spec.md","anchor":{"kind":"text","sourceText":"timeout"}},"label":"Timeout","note":"Preserve the timeout."})).await;
    assert!(status.is_success(), "{note}");
    let id = note["id"].as_str().unwrap();
    let item_path = format!("{path}/{id}");
    let (_, listed) = request(&client, &base, token, Method::GET, &path, json!({})).await;
    assert_eq!(listed["notes"][0]["id"], id);
    let (status, edited) = request(
        &client,
        &base,
        token,
        Method::PATCH,
        &item_path,
        json!({"note":"Use 30 seconds.","revision":1}),
    )
    .await;
    assert!(status.is_success());
    assert_eq!(edited["revision"], 2);
    let (status, _) = request(
        &client,
        &base,
        token,
        Method::PATCH,
        &item_path,
        json!({"note":"Stale edit","revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = request(
        &client,
        &base,
        token,
        Method::DELETE,
        &item_path,
        json!({"revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A second member can read, but cannot mutate the author's annotation.
    let other = Uuid::new_v4().to_string();
    let username = format!("annotation-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO users(user_id,username,password_hash) SELECT $1,$2,password_hash FROM users WHERE user_id=$3").bind(&other).bind(&username).bind(owner).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(&other)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')").bind(channel).bind(&other).execute(&db).await.unwrap();
    let other_auth = login(&client, &base, &username, &password).await;
    let other_token = other_auth["access_token"].as_str().unwrap();
    let (status, _) = request(
        &client,
        &base,
        other_token,
        Method::PATCH,
        &item_path,
        json!({"note":"Overwrite","revision":2}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(channel)
    .bind(&other)
    .execute(&db)
    .await
    .unwrap();
    let (status,_)=request(&client,&base,other_token,Method::POST,&path,json!({"target":{"kind":"file","path":"x.rs","anchor":{"kind":"file"}},"label":"x","note":"no"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = request(&client, &base, other_token, Method::GET, &path, json!({})).await;
    assert!(status.is_success());
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(channel)
        .bind(&other)
        .execute(&db)
        .await
        .unwrap();
    let (status, _) = request(&client, &base, other_token, Method::GET, &path, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Import preserves anchors/timestamps, remains idempotent, and never resurrects a deleted note.
    let old="annotations: 1\nnotes:\n  - id: legacy-timeout\n    path: docs/spec.md\n    anchor: {text: timeout}\n    label: Old timeout\n    note: Old comment\n    created: '2025-01-02T03:04:05Z'\n";
    sqlx::query("INSERT INTO context_files(file_id,channel_id,path,content) VALUES($1,$2,'annotations.yaml',$3)").bind(Uuid::new_v4().to_string()).bind(channel).bind(old).execute(&db).await.unwrap();
    let (_, imported) = request(&client, &base, token, Method::GET, &path, json!({})).await;
    let old_note = imported["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["label"] == "Old timeout")
        .unwrap();
    assert_eq!(old_note["target"]["anchor"]["kind"], "text");
    assert_eq!(old_note["created_at"], "2025-01-02T03:04:05Z");
    assert!(old_note["author_id"].is_null());
    let old_path = format!("{path}/{}", old_note["id"].as_str().unwrap());
    let (status, _) = request(
        &client,
        &base,
        token,
        Method::DELETE,
        &old_path,
        json!({"revision":1}),
    )
    .await;
    assert!(status.is_success());
    let (_, again) = request(&client, &base, token, Method::GET, &path, json!({})).await;
    assert_eq!(again["notes"].as_array().unwrap().len(), 1);
    sqlx::query("UPDATE context_files SET content='notes: [' WHERE channel_id=$1 AND path='annotations.yaml'").bind(channel).execute(&db).await.unwrap();
    let (status, warning) = request(&client, &base, token, Method::GET, &path, json!({})).await;
    assert!(status.is_success());
    assert!(warning["import_warning"].is_string());
    assert_eq!(warning["notes"].as_array().unwrap().len(), 1);
    sqlx::query(
        "UPDATE context_files SET content=$2 WHERE channel_id=$1 AND path='annotations.yaml'",
    )
    .bind(channel)
    .bind(old)
    .execute(&db)
    .await
    .unwrap();

    let message = Uuid::new_v4().to_string();
    let event = Uuid::new_v4().to_string();
    let bot = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username) VALUES($1,$2)")
        .bind(&bot)
        .bind(format!("annotation-bot-{}", Uuid::new_v4()))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,channel_seq) VALUES($1,$2,$3,'bot','Updated config',1)").bind(&message).bind(channel).bind(&bot).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO message_traces(id,msg_id,channel_id,bot_id,trace_seq,phase,title,data) VALUES($1,$2,$3,$4,1,'tool_call','Edit config',$5)").bind(&event).bind(&message).bind(channel).bind(&bot).bind(json!({"tool_call_id":"call-1","kind":"edit","path":"config.rs"})).execute(&db).await.unwrap();
    let target = json!({"kind":"event","msg_id":message,"event_id":event,"tool_call_id":"call-1","snapshot":{"phase":"spoofed","bot_id":null}});
    let (status, event_note) = request(
        &client,
        &base,
        token,
        Method::POST,
        &path,
        json!({"target":target,"label":"Edit config","note":"Keep error handling."}),
    )
    .await;
    assert!(status.is_success(), "{event_note}");
    assert_eq!(event_note["target"]["snapshot"]["phase"], "tool_call");
    assert_eq!(event_note["target"]["snapshot"]["bot_id"], bot);
    let wrong = Uuid::new_v4().to_string();
    let (status,_)=request(&client,&base,token,Method::POST,&path,json!({"target":{"kind":"event","msg_id":wrong,"event_id":event,"snapshot":{}},"label":"x","note":"bad anchor"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // SEE policy applies to both listing event annotations and creating them.
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'user','member')").bind(channel).bind(&other).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'user',$3,'tool_call','see','deny')").bind(&bot).bind(channel).bind(&other).execute(&db).await.unwrap();
    let (_, hidden) = request(&client, &base, other_token, Method::GET, &path, json!({})).await;
    assert_eq!(hidden["notes"].as_array().unwrap().len(), 1);
    let (status, _) = request(
        &client,
        &base,
        other_token,
        Method::POST,
        &path,
        json!({"target":target,"label":"Edit config","note":"Cannot see this."}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Retention can prune the trace while the note retains its source snapshot and SEE policy.
    sqlx::query("DELETE FROM message_traces WHERE id=$1")
        .bind(&event)
        .execute(&db)
        .await
        .unwrap();
    let (_, retained) = request(&client, &base, token, Method::GET, &path, json!({})).await;
    assert_eq!(retained["notes"].as_array().unwrap().len(), 2);
    let (_, hidden) = request(&client, &base, other_token, Method::GET, &path, json!({})).await;
    assert_eq!(hidden["notes"].as_array().unwrap().len(), 1);
}
