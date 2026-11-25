//! Agent file uploads across the real `/mcp`, the ticketed PUT route and object storage.
//! Tests that store bytes need a real bucket:
//!
//! INTEGRATION_S3_ENDPOINT=http://127.0.0.1:19000 INTEGRATION_S3_ACCESS_KEY=... \
//! INTEGRATION_S3_SECRET_KEY=... S3_BUCKET=... DATABASE_URL=postgres://... \
//! cargo test --features integration --test agent_uploads -- --include-ignored
#![cfg(feature = "integration")]

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

struct Fixture {
    _gateway: gateway::TestGateway,
    base: String,
    client: Client,
    user_token: String,
    channel: String,
    mcp_token: String,
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sample(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "upload-admin", &password).await;
        let client = Client::new();
        let auth: Value = client
            .post(format!("{base}/api/v1/auth/login"))
            .json(&json!({"login":"upload-admin","password":password}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let user_token = auth["access_token"].as_str().unwrap().to_string();
        let user = auth["user_id"].as_str().unwrap().to_string();
        let create = |path: &'static str, body: Value| {
            let (client, base, token) = (client.clone(), base.clone(), user_token.clone());
            async move {
                client
                    .post(format!("{base}/api/v1{path}"))
                    .bearer_auth(token)
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .json::<Value>()
                    .await
                    .unwrap()
            }
        };
        let workspace = create("/workspaces", json!({"name":"uploads"})).await;
        let channel = create(
            "/channels",
            json!({"workspace_id":workspace["workspace_id"],"name":"uploads"}),
        )
        .await;
        let channel = channel["channel_id"].as_str().unwrap().to_string();

        let bot = Uuid::new_v4().to_string();
        let host = Uuid::new_v4().to_string();
        let credential = server::infra::crypto::generate_host_credential();
        sqlx::query("INSERT INTO bot_accounts(bot_id,username,created_by,external_processor,binding_config) VALUES($1,$2,$3,FALSE,$4)")
            .bind(&bot).bind(format!("uploader-{bot}")).bind(&user)
            .bind(json!({"acp_security":{"require_capability":false}}))
            .execute(db).await.unwrap();
        sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
            .bind(&channel).bind(&bot).execute(db).await.unwrap();
        sqlx::query("INSERT INTO connector_hosts(host_id,bot_id,device_name,status,credential_hash) VALUES($1,$2,'uploads','active',$3)")
            .bind(&host).bind(&bot)
            .bind(server::infra::crypto::hash_host_credential(&credential))
            .execute(db).await.unwrap();

        let metadata: Value = client
            .get(format!("{base}/.well-known/oauth-protected-resource/mcp"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let minted: Value = client
            .post(format!("{base}/oauth/token"))
            .json(&json!({
                "grant_type":"client_credentials","client_id":host,"client_secret":credential,
                "resource":metadata["resource"],"scope":"cheers:read cheers:files:write",
                "cheers_channel":channel,
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        Self {
            _gateway: gateway,
            base,
            client,
            user_token,
            channel,
            mcp_token: minted["access_token"].as_str().unwrap().to_string(),
        }
    }

    async fn tool(&self, name: &str, arguments: Value) -> Value {
        let rpc: Value = self
            .client
            .post(format!("{}/mcp", self.base))
            .bearer_auth(&self.mcp_token)
            .header("MCP-Protocol-Version", "2025-11-25")
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":arguments}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        rpc["result"].clone()
    }

    async fn prepare(&self, bytes: &[u8]) -> Value {
        let result = self
            .tool(
                "artifact_upload_prepare",
                json!({"channel_id":self.channel,"filename":"deck.pptx",
                    "size_bytes":bytes.len(),"sha256":sha256(bytes)}),
            )
            .await;
        assert_eq!(result["isError"], false, "{result}");
        result["structuredContent"].clone()
    }

    async fn put(&self, upload: &Value, ticket: &str, bytes: Vec<u8>) -> StatusCode {
        self.client
            .put(upload["upload_url"].as_str().unwrap())
            .bearer_auth(ticket)
            .body(bytes)
            .send()
            .await
            .unwrap()
            .status()
    }

    async fn finish(&self, upload: &Value) -> Value {
        self.tool(
            "artifact_upload_finish",
            json!({"channel_id":self.channel,"upload_id":upload["upload_id"]}),
        )
        .await
    }

    async fn download(&self, file_id: &str) -> Vec<u8> {
        self.client
            .get(format!("{}/api/v1/files/{file_id}/download", self.base))
            .bearer_auth(&self.user_token)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .to_vec()
    }
}

fn error_code(result: &Value) -> &str {
    assert_eq!(result["isError"], true, "{result}");
    result["structuredContent"]["code"].as_str().unwrap()
}

fn ticket(upload: &Value) -> String {
    upload["upload_token"].as_str().unwrap().to_string()
}

async fn status(db: &PgPool, upload: &Value) -> String {
    sqlx::query_scalar("SELECT status FROM agent_file_uploads WHERE upload_id = $1")
        .bind(upload["upload_id"].as_str().unwrap())
        .fetch_one(db)
        .await
        .unwrap()
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn an_uploaded_file_downloads_byte_for_byte(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    // Larger than the gateway's default body limit, which this route must not inherit.
    let bytes = sample(20 * 1024 * 1024);
    let upload = fixture.prepare(&bytes).await;
    assert!(upload["command"].as_str().unwrap().contains("curl"));

    let token = ticket(&upload);
    assert_eq!(
        fixture.put(&upload, &token, bytes.clone()).await,
        StatusCode::OK
    );
    let published = fixture.finish(&upload).await;
    assert_eq!(published["isError"], false, "{published}");
    let file_id = published["structuredContent"]["file_id"].as_str().unwrap();
    let expires_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT expires_at FROM file_records WHERE file_id=$1")
            .bind(file_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(
        expires_at.is_none(),
        "Bot-authored artifacts must not expire"
    );
    assert!(
        published["structuredContent"]["artifact"]["uri"].is_string(),
        "{published}"
    );
    assert_eq!(fixture.download(file_id).await, bytes);
    let human: Value = fixture
        .client
        .post(format!("{}/api/v1/files", fixture.base))
        .bearer_auth(&fixture.user_token)
        .query(&[
            ("channel_id", fixture.channel.as_str()),
            ("filename", "human.txt"),
            ("content_type", "text/plain"),
        ])
        .body("human upload")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let human_expiry: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM file_records WHERE file_id=$1")
            .bind(human["file_id"].as_str().unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    let remaining = human_expiry - chrono::Utc::now();
    assert!(remaining > chrono::Duration::days(6) && remaining <= chrono::Duration::days(7));
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn the_command_the_agent_receives_uploads_the_file(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(2 * 1024 * 1024);
    let directory = std::env::temp_dir().join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("deck.pptx");
    std::fs::write(&path, &bytes).unwrap();

    let upload = fixture.prepare(&bytes).await;
    let command = upload["command"]
        .as_str()
        .unwrap()
        .replace("<FILE>", path.to_str().unwrap());
    let output = std::process::Command::new("sh")
        .args(["-c", &command])
        .output()
        .unwrap();
    std::fs::remove_dir_all(&directory).unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains(r#""status":"received""#), "{stdout}");

    let published = fixture.finish(&upload).await;
    let file_id = published["structuredContent"]["file_id"].as_str().unwrap();
    assert_eq!(fixture.download(file_id).await, bytes);
}

/// The test process's own storage handle, for the sweep that runs in `main`.
fn init_test_storage() -> (&'static aws_sdk_s3::Client, &'static str) {
    let credentials = aws_sdk_s3::config::Credentials::new(
        std::env::var("INTEGRATION_S3_ACCESS_KEY").unwrap(),
        std::env::var("INTEGRATION_S3_SECRET_KEY").unwrap(),
        None,
        None,
        "integration",
    );
    let config = aws_sdk_s3::config::Builder::new()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .endpoint_url(std::env::var("INTEGRATION_S3_ENDPOINT").unwrap())
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(credentials)
        .force_path_style(true)
        .build();
    server::resource::files::init_s3(
        aws_sdk_s3::Client::from_conf(config),
        std::env::var("S3_BUCKET").unwrap(),
    );
    server::resource::files::s3_handle().unwrap()
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn the_sweep_removes_abandoned_uploads_and_keeps_published_files(db: PgPool) {
    let (client, bucket) = init_test_storage();
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);

    let abandoned = fixture.prepare(&bytes).await;
    let token = ticket(&abandoned);
    assert_eq!(
        fixture.put(&abandoned, &token, bytes.clone()).await,
        StatusCode::OK
    );
    let published = fixture.prepare(&bytes).await;
    let token = ticket(&published);
    assert_eq!(
        fixture.put(&published, &token, bytes.clone()).await,
        StatusCode::OK
    );
    fixture.finish(&published).await;
    let live = fixture.prepare(&bytes).await;

    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT object_key FROM agent_file_uploads WHERE upload_id = ANY($1) ORDER BY upload_id = $2 DESC",
    )
    .bind(vec![
        abandoned["upload_id"].as_str().unwrap().to_string(),
        published["upload_id"].as_str().unwrap().to_string(),
    ])
    .bind(abandoned["upload_id"].as_str().unwrap())
    .fetch_all(&db)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent_file_uploads SET expires_at = NOW() - INTERVAL '1 hour'
         WHERE upload_id = ANY($1)",
    )
    .bind(vec![
        abandoned["upload_id"].as_str().unwrap().to_string(),
        published["upload_id"].as_str().unwrap().to_string(),
    ])
    .execute(&db)
    .await
    .unwrap();

    assert_eq!(
        server::resource::uploads::sweep_expired(&db).await.unwrap(),
        1
    );
    assert!(server::infra::s3::get_object(client, bucket, &keys[0])
        .await
        .is_err());
    assert_eq!(
        server::infra::s3::get_object(client, bucket, &keys[1])
            .await
            .unwrap(),
        bytes
    );
    assert_eq!(status(&db, &published).await, "published");
    assert_eq!(status(&db, &live).await, "pending");
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn publishing_twice_returns_the_same_artifact(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);
    assert_eq!(fixture.put(&upload, &token, bytes).await, StatusCode::OK);

    let first = fixture.finish(&upload).await;
    let second = fixture.finish(&upload).await;
    assert_eq!(first["structuredContent"], second["structuredContent"]);
    let records: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM file_records WHERE channel_id = $1")
            .bind(&fixture.channel)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(records, 1);
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn a_used_ticket_cannot_replace_the_file(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);
    assert_eq!(
        fixture.put(&upload, &token, bytes.clone()).await,
        StatusCode::OK
    );
    fixture.put(&upload, &token, sample(2048)).await;

    let published = fixture.finish(&upload).await;
    let file_id = published["structuredContent"]["file_id"].as_str().unwrap();
    assert_eq!(fixture.download(file_id).await, bytes);
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn a_failed_upload_can_be_retried_with_the_right_file(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);

    let mut damaged = bytes.clone();
    damaged[100] ^= 1;
    assert_eq!(
        fixture.put(&upload, &token, damaged).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(status(&db, &upload).await, "pending");
    assert_eq!(fixture.put(&upload, &token, bytes).await, StatusCode::OK);
    assert_eq!(status(&db, &upload).await, "received");
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn simultaneous_uploads_of_one_file_store_it_once(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(1024 * 1024);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);

    let (first, second) = tokio::join!(
        fixture.put(&upload, &token, bytes.clone()),
        fixture.put(&upload, &token, bytes.clone()),
    );
    assert!(
        [first, second].contains(&StatusCode::OK),
        "{first} and {second}"
    );
    assert!(
        [first, second]
            .iter()
            .all(|s| matches!(*s, StatusCode::OK | StatusCode::CONFLICT)),
        "{first} and {second}"
    );
    assert_eq!(status(&db, &upload).await, "received");
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn an_upload_for_one_person_cannot_be_published_for_another(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);
    assert_eq!(fixture.put(&upload, &token, bytes).await, StatusCode::OK);

    sqlx::query("UPDATE agent_file_uploads SET on_behalf_of = $2 WHERE upload_id = $1")
        .bind(upload["upload_id"].as_str().unwrap())
        .bind(Uuid::new_v4().to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(error_code(&fixture.finish(&upload).await), "NOT_FOUND");
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn losing_channel_access_stops_publishing(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);
    assert_eq!(fixture.put(&upload, &token, bytes).await, StatusCode::OK);

    sqlx::query("DELETE FROM channel_memberships WHERE channel_id = $1 AND member_type = 'bot'")
        .bind(&fixture.channel)
        .execute(&db)
        .await
        .unwrap();
    let result = fixture.finish(&upload).await;
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(status(&db, &upload).await, "received");
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn tickets_are_refused_unless_valid_and_live(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let id = upload["upload_id"].as_str().unwrap();
    let token = ticket(&upload);

    assert_eq!(
        fixture.put(&upload, "not-the-ticket", bytes.clone()).await,
        StatusCode::UNAUTHORIZED
    );
    let other = fixture.prepare(&sample(100)).await;
    assert_eq!(
        fixture.put(&upload, &ticket(&other), bytes.clone()).await,
        StatusCode::UNAUTHORIZED
    );

    // A ticket whose task has ended stops working.
    sqlx::query("UPDATE agent_file_uploads SET execution_id = $2 WHERE upload_id = $1")
        .bind(id)
        .bind(Uuid::new_v4().to_string())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        fixture.put(&upload, &token, bytes.clone()).await,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE agent_file_uploads SET execution_id = NULL, expires_at = NOW() WHERE upload_id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        fixture.put(&upload, &token, bytes).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        error_code(&fixture.finish(&upload).await),
        "E_UPLOAD_EXPIRED"
    );
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn the_wrong_size_is_refused(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let bytes = sample(4096);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);

    assert_eq!(
        fixture.put(&upload, &token, sample(4097)).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        fixture.put(&upload, &token, sample(4095)).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        error_code(&fixture.finish(&upload).await),
        "E_UPLOAD_INCOMPLETE"
    );
}

#[sqlx::test]
#[ignore = "needs object storage: set INTEGRATION_S3_ENDPOINT"]
async fn prepare_refuses_bad_requests(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let prepare = |size: i64, hash: &'static str| {
        fixture.tool(
            "artifact_upload_prepare",
            json!({"channel_id":fixture.channel,"filename":"a.bin","size_bytes":size,"sha256":hash}),
        )
    };
    let hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(
        error_code(&prepare(33 * 1024 * 1024, hash).await),
        "E_TOO_LARGE"
    );
    assert_eq!(error_code(&prepare(0, hash).await), "INVALID_PARAMS");
    assert_eq!(error_code(&prepare(10, "short").await), "INVALID_PARAMS");
    for _ in 0..20 {
        assert_eq!(prepare(10, hash).await["isError"], false);
    }
    assert_eq!(error_code(&prepare(10, hash).await), "E_TOO_MANY_UPLOADS");
}

#[sqlx::test]
async fn a_storage_failure_leaves_the_upload_open(db: PgPool) {
    if std::env::var_os("INTEGRATION_S3_ENDPOINT").is_some() {
        return;
    }
    // The fixture's dead endpoint still builds a client, so a real file fails at the PUT
    // with nothing stored and the upload left open for a retry.
    let fixture = Fixture::start(&db).await;
    let bytes = sample(100);
    let upload = fixture.prepare(&bytes).await;
    let token = ticket(&upload);
    assert_eq!(
        fixture.put(&upload, &token, bytes).await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(status(&db, &upload).await, "pending");
}
