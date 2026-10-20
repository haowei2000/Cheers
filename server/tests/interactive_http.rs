//! Real gateway HTTP validation plus the shared durable request receipt.
#![cfg(feature = "integration")]
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use server::domain::messages::{self, CreateMessageParams};
use server::gateway::{
    realtime::fanout::{Fanout, InProcessFanout},
    registry::{BotLocator, BotRegistry, InProcessBotLocator},
    stream::StreamRegistry,
};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
#[path = "support/gateway.rs"]
mod gateway;

async fn post(
    client: &Client,
    base: &str,
    token: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = client
        .post(format!("{base}/api/v1{path}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}

#[sqlx::test]
async fn interactive_http_rejects_forged_stale_requests_and_replays_accepted_receipt(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "interactive-admin", &password).await;
    let client = Client::new();
    let (status, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login":"interactive-admin","password":password}),
    )
    .await;
    assert!(status.is_success(), "{auth}");
    let token = auth["access_token"].as_str().unwrap();
    let user: Uuid = auth["user_id"].as_str().unwrap().parse().unwrap();
    let (_, ws) = post(
        &client,
        &base,
        token,
        "/workspaces",
        json!({"name":"interactive"}),
    )
    .await;
    let (_, ch) = post(
        &client,
        &base,
        token,
        "/channels",
        json!({"workspace_id":ws["workspace_id"],"name":"interactive"}),
    )
    .await;
    let channel: Uuid = ch["channel_id"].as_str().unwrap().parse().unwrap();
    let bot = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor) VALUES($1,$2,FALSE)")
        .bind(bot.to_string())
        .bind(format!("interactive-{bot}"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')").bind(channel.to_string()).bind(bot.to_string()).execute(&db).await.unwrap();
    let mut document: Value =
        serde_json::from_str(cheers_mcp_server::interactive::EXAMPLE).unwrap();
    let action =
        &mut document["messages"][1]["updateComponents"]["components"][6]["action"]["event"];
    action["name"] = json!("cheers.request");
    action["context"]["botId"] = json!(bot);
    let mut duplicate = document["messages"][1]["updateComponents"]["components"][6].clone();
    duplicate["id"] = json!("prepare-other");
    duplicate["action"]["event"]["context"]["payload"]["includeSources"] = json!(true);
    document["messages"][1]["updateComponents"]["components"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let written = server::resource::fs::handle_write(&db, &server::resource::Principal::bot(bot), &json!({"channel_id":channel,"path":"forms/report.a2ui.json","content":document.to_string(),"if_version":0})).await.unwrap();
    assert_eq!(written["version"], 1);
    let event = json!({"v":1,"sourceUri":"cheers:desk/forms/report.a2ui.json","sourceVersion":1,"surfaceId":"report","componentId":"prepare","actionId":"report.prepare","botId":bot,"invocationId":Uuid::new_v4(),"input":{"topic":"New topic","includeSources":false}});
    let body = json!({"content":"Resource request", "mention_ids":[bot],"context_bundle":{"items":[],"interaction":event}});
    let endpoint = format!("/channels/{channel}/messages");
    let mut forged = body.clone();
    forged["context_bundle"]["interaction"]["actionId"] = json!("undeclared");
    assert_eq!(
        post(&client, &base, token, &endpoint, forged).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut stale = body.clone();
    stale["context_bundle"]["interaction"]["sourceVersion"] = json!(2);
    assert_eq!(
        post(&client, &base, token, &endpoint, stale).await.0,
        StatusCode::CONFLICT
    );
    let mut extra = body.clone();
    extra["context_bundle"]["interaction"]["input"]["command"] = json!("execute");
    assert_eq!(
        post(&client, &base, token, &endpoint, extra).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut wrong_target = body.clone();
    wrong_target["mention_ids"] = json!([]);
    assert_eq!(
        post(&client, &base, token, &endpoint, wrong_target).await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, offline) = post(&client, &base, token, &endpoint, body.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(offline.to_string().contains("offline"), "{offline}");

    // Reused action IDs must validate against the submitted component identity.
    let mut other = body.clone();
    other["context_bundle"]["interaction"]["componentId"] = json!("prepare-other");
    other["context_bundle"]["interaction"]["invocationId"] = json!(Uuid::new_v4());
    assert_eq!(
        post(&client, &base, token, &endpoint, other.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    other["context_bundle"]["interaction"]["input"]["includeSources"] = json!(true);
    let (status, offline) = post(&client, &base, token, &endpoint, other).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(offline.to_string().contains("offline"), "{offline}");
    let mut wrong_surface = body.clone();
    wrong_surface["context_bundle"]["interaction"]["surfaceId"] = json!("other");
    assert_eq!(
        post(&client, &base, token, &endpoint, wrong_surface)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // YAML files must use the same parsed action contract as JSON files.
    for extension in ["yaml", "yml"] {
        let path = format!("forms/report.a2ui.{extension}");
        server::resource::fs::handle_write(&db, &server::resource::Principal::bot(bot),
            &json!({"channel_id":channel,"path":path,"content":serde_yaml::to_string(&document).unwrap(),"if_version":0})).await.unwrap();
        let mut yaml = body.clone();
        yaml["context_bundle"]["interaction"]["sourceUri"] = json!(format!("cheers:desk/{path}"));
        yaml["context_bundle"]["interaction"]["invocationId"] = json!(Uuid::new_v4());
        let (status, offline) = post(&client, &base, token, &endpoint, yaml).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(offline.to_string().contains("offline"), "{offline}");
    }

    // Bind an in-process receiver to accept the first request using the same
    // domain pipeline. HTTP then retries after the source revision changes.
    let locator = InProcessBotLocator::new();
    let (control_tx, mut control_rx) = tokio::sync::mpsc::channel(8);
    let (data_tx, _data_rx) = tokio::sync::mpsc::channel(8);
    let control_connection = Uuid::new_v4();
    let _connection = locator.bind_control(bot, control_connection, control_tx);
    assert!(locator.set_task_acceptance(bot, control_connection, true));
    locator.bind_data(bot, Uuid::new_v4(), data_tx);
    let bot_locator: Arc<dyn BotLocator> = locator;
    let fanout: Arc<dyn Fanout> = InProcessFanout::new();
    let receipt = messages::create_message(
        &db,
        &fanout,
        &StreamRegistry::new(),
        &bot_locator,
        CreateMessageParams {
            user_id: user,
            channel_id: channel,
            content: "Resource request".into(),
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![bot],
            mention_names: vec![],
            session_id: None,
            msg_id: None,
            context_bundle: server::domain::context_bundle::sanitize_human_bundle(
                &body["context_bundle"],
            ),
        },
    )
    .await
    .unwrap();
    let task = control_rx.recv().await.unwrap();
    assert_eq!(task["context_bundle"]["interaction"], event);
    server::resource::fs::handle_write(&db,&server::resource::Principal::bot(bot),&json!({"channel_id":channel,"path":"forms/report.a2ui.json","content":document.to_string(),"if_version":1})).await.unwrap();
    let (status, retry) = post(&client, &base, token, &endpoint, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{retry}");
    assert_eq!(retry["msg_id"], receipt.msg_id);
    assert!(control_rx.try_recv().is_err());
    // Current authorization still applies to a replay.
    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(channel.to_string())
    .bind(user.to_string())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        post(&client, &base, token, &endpoint, body).await.0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test]
async fn interactive_http_validates_tsx_canvas_actions(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "tsx-admin", &password).await;
    let client = Client::new();
    let (status, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login":"tsx-admin","password":password}),
    )
    .await;
    assert!(status.is_success(), "{auth}");
    let token = auth["access_token"].as_str().unwrap();
    let (_, ws) = post(
        &client,
        &base,
        token,
        "/workspaces",
        json!({"name":"tsx-ws"}),
    )
    .await;
    let (_, ch) = post(
        &client,
        &base,
        token,
        "/channels",
        json!({"workspace_id":ws["workspace_id"],"name":"tsx-ch"}),
    )
    .await;
    let channel: Uuid = ch["channel_id"].as_str().unwrap().parse().unwrap();
    let bot = Uuid::new_v4();
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor) VALUES($1,$2,FALSE)")
        .bind(bot.to_string())
        .bind(format!("tsx-bot-{bot}"))
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
        .bind(channel.to_string())
        .bind(bot.to_string())
        .execute(&db)
        .await
        .unwrap();

    let tsx_source = cheers_mcp_server::interactive::tsx_request_example(&bot.to_string());
    let written = server::resource::fs::handle_write(
        &db,
        &server::resource::Principal::bot(bot),
        &json!({
            "channel_id": channel,
            "path": "cards/report.tsx",
            "content": tsx_source,
            "if_version": 0
        }),
    )
    .await
    .unwrap();
    assert_eq!(written["version"], 1);

    let event = json!({
        "v": 1,
        "sourceUri": "cheers:desk/cards/report.tsx",
        "sourceVersion": 1,
        "surfaceId": "root",
        "componentId": "report.prepare",
        "actionId": "report.prepare",
        "botId": bot,
        "invocationId": Uuid::new_v4(),
        "input": { "topic": "Quarterly Analysis", "includeSources": false }
    });
    let body = json!({
        "content": "Resource request",
        "mention_ids": [bot],
        "context_bundle": { "items": [], "interaction": event }
    });
    let endpoint = format!("/channels/{channel}/messages");

    // 1. Undeclared action is rejected
    let mut undeclared = body.clone();
    undeclared["context_bundle"]["interaction"]["actionId"] = json!("fake_action");
    assert_eq!(
        post(&client, &base, token, &endpoint, undeclared).await.0,
        StatusCode::BAD_REQUEST
    );

    // 2. Mismatched input (extra field) is rejected
    let mut bad_input = body.clone();
    bad_input["context_bundle"]["interaction"]["input"]["extra"] = json!("malicious");
    assert_eq!(
        post(&client, &base, token, &endpoint, bad_input).await.0,
        StatusCode::BAD_REQUEST
    );

    // 3. Both checkbox states are valid variable input
    let mut checked = body.clone();
    checked["context_bundle"]["interaction"]["input"]["includeSources"] = json!(true);
    let (status, offline) = post(&client, &base, token, &endpoint, checked).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(offline.to_string().contains("offline"), "{offline}");

    // 4. Stale version is rejected with Conflict
    let mut stale = body.clone();
    stale["context_bundle"]["interaction"]["sourceVersion"] = json!(2);
    assert_eq!(
        post(&client, &base, token, &endpoint, stale).await.0,
        StatusCode::CONFLICT
    );

    // 5. Valid TSX request passes validation (fails with bot offline Conflict since bot is not bound)
    let (status, offline) = post(&client, &base, token, &endpoint, body.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(offline.to_string().contains("offline"), "{offline}");
}
