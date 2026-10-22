//! Global identity and user-private CAS drafts through real authenticated HTTP.
#![cfg(feature = "integration")]
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;
#[path = "support/gateway.rs"]
mod gateway;
async fn post(c: &Client, b: &str, t: &str, p: &str, v: Value) -> (StatusCode, Value) {
    let r = c
        .post(format!("{b}/api/v1{p}"))
        .bearer_auth(t)
        .json(&v)
        .send()
        .await
        .unwrap();
    (r.status(), r.json().await.unwrap())
}
#[sqlx::test]
async fn stable_uri_history_and_private_draft_cas(db: PgPool) {
    let resource_locator: std::sync::Arc<dyn server::gateway::registry::BotLocator> =
        server::gateway::registry::InProcessBotLocator::new();
    let password = Uuid::new_v4().to_string();
    let (_g, base) = gateway::TestGateway::start(&db, "resource-admin", &password).await;
    let client = Client::new();
    let (_, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login":"resource-admin","password":password}),
    )
    .await;
    let token = auth["access_token"].as_str().unwrap();
    let user: Uuid = auth["user_id"].as_str().unwrap().parse().unwrap();
    let (_, ws) = post(
        &client,
        &base,
        token,
        "/workspaces",
        json!({"name":"resources"}),
    )
    .await;
    let (_, channel) = post(
        &client,
        &base,
        token,
        "/channels",
        json!({"workspace_id":ws["workspace_id"],"name":"resource-tests"}),
    )
    .await;
    let channel = channel["channel_id"].as_str().unwrap();
    let principal = server::resource::Principal::user(user);
    server::resource::fs::handle_write(
        &db,
        &principal,
        &json!({"channel_id":channel,"path":"draft.txt","content":"first","if_version":0}),
    )
    .await
    .unwrap();
    let first = server::resource::fs::handle_read(
        &db,
        &principal,
        &json!({"channel_id":channel,"path":"draft.txt"}),
    )
    .await
    .unwrap();
    let uri = first["uri"].as_str().unwrap();
    assert!(uri.starts_with("cheers:resource/"));
    let (status, resolved) = post(
        &client,
        &base,
        token,
        "/resources/resolve",
        json!({"uri":uri}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["content"], "first");
    let key = json!({"uri":uri,"view_id":"tsx:root","schema_version":1,"source_version":1,"if_revision":0,"data":{"topic":"draft"}});
    let save = |body: Value| {
        client
            .put(format!("{base}/api/v1/resources/draft"))
            .bearer_auth(token)
            .json(&body)
            .send()
    };
    let response = save(key.clone()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap()["revision"], 1);
    assert_eq!(
        save(key.clone()).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    let mut newer = key.clone();
    newer["if_revision"] = json!(1);
    newer["data"] = json!({"topic":"second device"});
    assert_eq!(save(newer).await.unwrap().status(), StatusCode::OK);
    server::resource::fs::handle_write(
        &db,
        &principal,
        &json!({"channel_id":channel,"path":"draft.txt","content":"second","if_version":1}),
    )
    .await
    .unwrap();
    let (_, pinned) = post(
        &client,
        &base,
        token,
        "/resources/resolve",
        json!({"uri":format!("{uri}?v=1")}),
    )
    .await;
    assert_eq!(pinned["content"], "first");
    assert_eq!(pinned["latest_version"], 2);
    assert_eq!(
        save(key.clone()).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    let draft = client
        .get(format!("{base}/api/v1/resources/draft"))
        .bearer_auth(token)
        .query(&[
            ("uri", uri),
            ("view_id", "tsx:root"),
            ("schema_version", "1"),
        ])
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(draft["stale"], true);
    assert_eq!(draft["data"]["topic"], "second device");
    // A guessed URI grants no access, even to another authenticated user.
    let stranger = Uuid::new_v4();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'unused')")
        .bind(stranger.to_string())
        .bind(format!("stranger-{stranger}"))
        .execute(&db)
        .await
        .unwrap();
    assert!(server::api::resources::desk_resource(
        &db,
        &server::resource::Principal::user(stranger),
        uri,
        None
    )
    .await
    .is_err());
    // Channel-scoped bridge calls cannot use the global name to escape their scope.
    let frame = json!({"req_id":"bound","resource":uri,"params":{"channel_id":Uuid::new_v4()}});
    let denied = server::resource::dispatch(&db, principal, &frame, &resource_locator).await;
    assert_eq!(denied["ok"], false);
    sqlx::query("DELETE FROM context_files WHERE file_id=$1")
        .bind(first["resource_id"].as_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        post(
            &client,
            &base,
            token,
            "/resources/resolve",
            json!({"uri":uri})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(
            &client,
            &base,
            token,
            "/resources/resolve",
            json!({"uri":format!("{uri}?v=1")})
        )
        .await
        .1["content"],
        "first"
    );
}

#[sqlx::test]
async fn execution_validates_source_and_keeps_one_private_receipt(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_g, base) = gateway::TestGateway::start(&db, "execution-admin", &password).await;
    let client = Client::new();
    let (_, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login":"execution-admin","password":password}),
    )
    .await;
    let token = auth["access_token"].as_str().unwrap();
    let user: Uuid = auth["user_id"].as_str().unwrap().parse().unwrap();
    let (_, ws) = post(
        &client,
        &base,
        token,
        "/workspaces",
        json!({"name":"executions"}),
    )
    .await;
    let (_, channel) = post(
        &client,
        &base,
        token,
        "/channels",
        json!({"workspace_id":ws["workspace_id"],"name":"execution-tests"}),
    )
    .await;
    let channel = channel["channel_id"].as_str().unwrap();
    let bot = Uuid::new_v4();
    let host = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor) VALUES($1,$2,TRUE)")
        .bind(bot.to_string())
        .bind(format!("execute-{bot}"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')").bind(channel).bind(bot.to_string()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO connector_hosts(host_id,bot_id,device_name,status) VALUES($1,$2,'test-host','active')").bind(host.to_string()).bind(bot.to_string()).execute(&db).await.unwrap();
    let declaration = json!([{"actionId":"terminal.run","name":"cheers.execute","botId":bot,"payload":{"action":"terminal.start","path":"","command":null},"presentation":["minimal","medium","max"],"version":1}]);
    let content = format!(
        "/**\n * @cheers-actions\n * {}\n */\nexport default function Card() {{return null;}}",
        declaration
    );
    let file = server::resource::fs::handle_write(
        &db,
        &server::resource::Principal::user(user),
        &json!({"channel_id":channel,"path":"terminal.tsx","content":content,"if_version":0}),
    )
    .await
    .unwrap();
    let invocation = Uuid::new_v4();
    let event = json!({"v":1,"sourceUri":file["uri"],"sourceVersion":1,"surfaceId":"root","componentId":"terminal.run","actionId":"terminal.run","botId":bot,"invocationId":invocation,"input":{"action":"terminal.start","path":"","command":"printf test"}});
    let body = json!({"bot_id":bot,"host_id":host,"invocation_id":invocation,"action":"terminal.start","path":"","command":"printf test","source_event":event});
    let endpoint = format!("/channels/{channel}/remote-executions");
    let mut forged = body.clone();
    forged["source_event"]["actionId"] = json!("forged");
    assert_eq!(
        post(&client, &base, token, &endpoint, forged).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut changed = body.clone();
    changed["command"] = json!("echo changed");
    assert_eq!(
        post(&client, &base, token, &endpoint, changed).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut wrong_host = body.clone();
    wrong_host["host_id"] = json!(Uuid::new_v4());
    assert_eq!(
        post(&client, &base, token, &endpoint, wrong_host).await.0,
        StatusCode::CONFLICT
    );
    let (status, receipt) = post(&client, &base, token, &endpoint, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    let id = receipt["execution_id"].as_str().unwrap();
    assert_eq!(
        post(&client, &base, token, &endpoint, body.clone()).await.1["execution_id"],
        id
    );
    let mut different = body.clone();
    different["command"] = json!("echo changed");
    assert_eq!(
        post(&client, &base, token, &endpoint, different).await.0,
        StatusCode::CONFLICT
    );
    // Retained content is readable history, not an active authority to execute.
    sqlx::query("DELETE FROM context_files WHERE file_id=$1")
        .bind(file["resource_id"].as_str().unwrap())
        .execute(&db)
        .await
        .unwrap();
    let mut deleted = body.clone();
    let next = Uuid::new_v4();
    deleted["invocation_id"] = json!(next);
    deleted["source_event"]["invocationId"] = json!(next);
    deleted["source_event"]["sourceUri"] = json!(format!("{}?v=1", file["uri"].as_str().unwrap()));
    assert_eq!(
        post(&client, &base, token, &endpoint, deleted).await.0,
        StatusCode::CONFLICT
    );
    for _ in 0..50 {
        let (_, r) = post(
            &client,
            &base,
            token,
            &format!("/resources/executions/{id}"),
            json!({"action":"terminal.status"}),
        )
        .await;
        if r["status"] == "failed" {
            assert!(r["result"]["error"].as_str().unwrap().contains("offline"));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("Offline host did not produce a durable failure receipt");
}
