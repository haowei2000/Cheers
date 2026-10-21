//! Cross-transport authorization and scheduled-send policy regressions.
#![cfg(feature = "integration")]

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

#[path = "support/gateway.rs"]
mod gateway;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

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

async fn setup(db: &PgPool) -> (gateway::TestGateway, String, Client, String, Uuid, Uuid) {
    let password = Uuid::new_v4().to_string();
    let (gateway, base) = gateway::TestGateway::start(db, "policy-admin", &password).await;
    let client = Client::new();
    let (status, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login":"policy-admin","password":password}),
    )
    .await;
    assert!(status.is_success(), "{auth}");
    let token = auth["access_token"].as_str().unwrap().to_string();
    let user = auth["user_id"].as_str().unwrap().parse().unwrap();
    let (status, workspace) = post(
        &client,
        &base,
        &token,
        "/workspaces",
        json!({"name":"policy"}),
    )
    .await;
    assert!(status.is_success(), "{workspace}");
    let (status, channel) = post(
        &client,
        &base,
        &token,
        "/channels",
        json!({"workspace_id":workspace["workspace_id"],"name":"policy"}),
    )
    .await;
    assert!(status.is_success(), "{channel}");
    (
        gateway,
        base,
        client,
        token,
        user,
        channel["channel_id"].as_str().unwrap().parse().unwrap(),
    )
}

async fn frame(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("expected gateway frame")
            .unwrap()
            .unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn resource(socket: &mut Socket, name: &str, params: Value) -> Value {
    socket
        .send(Message::Text(
            json!({"type":"resource_req","req_id":"test-resource","resource":name,"params":params})
                .to_string(),
        ))
        .await
        .unwrap();
    loop {
        let response = frame(socket).await;
        if response["type"] == "resource_res" {
            return response;
        }
    }
}

#[sqlx::test]
async fn readonly_send_and_browser_bot_resource_are_denied_while_file_effects_are_shared(
    db: PgPool,
) {
    let (_gateway, base, client, token, user, channel) = setup(&db).await;
    let (mut socket, _) = connect_async(format!("{}/ws", base.replacen("http:", "ws:", 1)))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({"type":"auth","token":token}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(frame(&mut socket).await["type"], "auth_ok");

    sqlx::query(
        "UPDATE channel_memberships SET role='readonly' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(channel.to_string())
    .bind(user.to_string())
    .execute(&db)
    .await
    .unwrap();
    let endpoint = format!("/channels/{channel}/messages");
    assert_eq!(
        post(
            &client,
            &base,
            &token,
            &endpoint,
            json!({"content":"readonly must not post"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    sqlx::query(
        "UPDATE channel_memberships SET role='member' WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(channel.to_string())
    .bind(user.to_string())
    .execute(&db)
    .await
    .unwrap();
    let denied = resource(
        &mut socket,
        "channel.messages.create",
        json!({"channel_id":channel,"content":"forged bot semantics"}),
    )
    .await;
    assert_eq!(denied["ok"], false, "{denied}");
    assert_eq!(denied["error"]["code"], "PERMISSION_DENIED");
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user'",
    )
    .bind(channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 0, "rejected transports must not persist a message");

    socket
        .send(Message::Text(
            json!({"type":"subscribe","channel_id":channel}).to_string(),
        ))
        .await
        .unwrap();
    loop {
        if frame(&mut socket).await["type"] == "subscribed" {
            break;
        }
    }
    let written = resource(
        &mut socket,
        "fs.write",
        json!({"channel_id":channel,"path":"shared.txt","content":"shared effects","if_version":0}),
    )
    .await;
    assert_eq!(written["ok"], true, "{written}");
    loop {
        let event = frame(&mut socket).await;
        if event["type"] == "board_signal" {
            assert_eq!(event["data"]["board"], "files");
            break;
        }
    }
    let denied = resource(
        &mut socket,
        "fs.rm",
        json!({"channel_id":channel,"path":"shared.txt"}),
    )
    .await;
    assert_eq!(
        denied["error"]["code"], "PERMISSION_DENIED",
        "shared effects must retain user-only admin gate: {denied}"
    );
    let (status, sent) = post(&client, &base, &token, &endpoint, json!({"content":"ordinary user message", "context_bundle":{"origin":"bot","items":[{"verb":"channel.messages.create","params":{}},{"verb":"channel.plan.read","params":{"channel_id":channel}}]}})).await;
    assert_eq!(status, StatusCode::CREATED, "{sent}");
    assert_eq!(sent["context_bundle"]["origin"], "human");
    assert_eq!(sent["context_bundle"]["items"].as_array().unwrap().len(), 1);
    loop {
        let event = frame(&mut socket).await;
        if event["type"] == "message" {
            assert_eq!(event["data"]["msg_id"], sent["msg_id"]);
            break;
        }
    }
}

#[sqlx::test]
async fn scheduled_dm_rechecks_blocking_at_execution(db: PgPool) {
    let (_gateway, base, client, token, user, _) = setup(&db).await;
    let peer = Uuid::new_v4();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,'test-only')")
        .bind(peer.to_string())
        .bind(format!("peer-{peer}"))
        .execute(&db)
        .await
        .unwrap();
    let dm = server::domain::dms::open_dm(
        &db,
        server::domain::dms::Participant::User(user),
        server::domain::dms::Participant::User(peer),
    )
    .await
    .unwrap()
    .channel_id;
    let (status, task) = post(&client, &base, &token, "/scheduled-messages", json!({"title":"later","channelId":dm,"content":"scheduled DM","schedule":{"kind":"once","runAt":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}})).await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    sqlx::query("INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)")
        .bind(peer.to_string())
        .bind(user.to_string())
        .execute(&db)
        .await
        .unwrap();
    let endpoint = format!("/channels/{dm}/messages");
    assert_eq!(
        post(
            &client,
            &base,
            &token,
            &endpoint,
            json!({"content":"blocked immediate"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let run = format!("/scheduled-messages/{}/run", task["id"].as_str().unwrap());
    let (status, result) = post(&client, &base, &token, &run, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user'",
    )
    .bind(dm.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "a previously authorized schedule cannot bypass a later block"
    );
}

#[sqlx::test]
async fn consent_follows_resolved_names_replies_and_default_bot_targets(db: PgPool) {
    let resource_locator: std::sync::Arc<dyn server::gateway::registry::BotLocator> =
        server::gateway::registry::InProcessBotLocator::new();
    let (_gateway, base, client, token, _, channel) = setup(&db).await;
    let bot = Uuid::new_v4();
    let name = format!("external-{bot}");
    sqlx::query("INSERT INTO bot_accounts(bot_id,username,external_processor) VALUES($1,$2,TRUE)")
        .bind(bot.to_string())
        .bind(&name)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channel_memberships(channel_id,member_id,member_type,role) VALUES($1,$2,'bot','member')")
        .bind(channel.to_string()).bind(bot.to_string()).execute(&db).await.unwrap();
    let endpoint = format!("/channels/{channel}/messages");
    // A passive external member must not block ordinary human chat.
    assert_eq!(
        post(
            &client,
            &base,
            &token,
            &endpoint,
            json!({"content":"human chat"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    for names in [vec![name], vec!["@here".into()]] {
        let (status, error) = post(
            &client,
            &base,
            &token,
            &endpoint,
            json!({"content":"named bot","mention_names":names}),
        )
        .await;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{error}");
        assert_eq!(error["code"], "ai_consent_required");
    }
    sqlx::query("UPDATE channels SET default_bot_id=$2 WHERE channel_id=$1")
        .bind(channel.to_string())
        .bind(bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    let (status, error) = post(
        &client,
        &base,
        &token,
        &endpoint,
        json!({"content":"default bot"}),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{error}");
    sqlx::query("INSERT INTO bot_event_access(bot_id,channel_id,subject_kind,subject_id,event_class,capability,decision) VALUES($1,$2,'role','*','prompt','initiate','deny')")
        .bind(bot.to_string()).bind(channel.to_string()).execute(&db).await.unwrap();
    let (status, message) = post(
        &client,
        &base,
        &token,
        &endpoint,
        json!({"content":"human chat with denied default"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "denied bots cannot require consent: {message}"
    );
    sqlx::query("DELETE FROM bot_event_access WHERE bot_id=$1")
        .bind(bot.to_string())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE channels SET default_bot_id=NULL WHERE channel_id=$1")
        .bind(channel.to_string())
        .execute(&db)
        .await
        .unwrap();
    let bot_message = server::resource::dispatch(&db, server::resource::Principal::bot(bot), &json!({"req_id":"bot-message","resource":"channel.messages.create","params":{"channel_id":channel,"content":"reply to me"}}), &resource_locator).await;
    assert_eq!(bot_message["ok"], true, "{bot_message}");
    let (status, error) = post(
        &client,
        &base,
        &token,
        &endpoint,
        json!({"content":"reply bot","reply_to_msg_id":bot_message["data"]["msg_id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{error}");
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id=$1 AND sender_type='user'",
    )
    .bind(channel.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        count, 2,
        "only the two untriggered human messages should persist"
    );
}
