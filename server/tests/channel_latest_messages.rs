//! Conversation-list previews: one batch read that keeps `list_messages` visibility.
#![cfg(feature = "integration")]

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
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

async fn create_channel(
    client: &Client,
    base: &str,
    token: &str,
    workspace: &Value,
    name: &str,
) -> String {
    let (status, channel) = post(
        client,
        base,
        token,
        "/channels",
        json!({"workspace_id": workspace["workspace_id"], "name": name}),
    )
    .await;
    assert!(status.is_success(), "{channel}");
    channel["channel_id"].as_str().unwrap().to_string()
}

async fn send(client: &Client, base: &str, token: &str, channel: &str, content: &str) {
    let (status, sent) = post(
        client,
        base,
        token,
        &format!("/channels/{channel}/messages"),
        json!({"content": content}),
    )
    .await;
    assert!(status.is_success(), "{sent}");
}

#[sqlx::test]
async fn latest_messages_returns_the_newest_row_of_joined_channels_only(db: PgPool) {
    let password = Uuid::new_v4().to_string();
    let (_gateway, base) = gateway::TestGateway::start(&db, "latest-admin", &password).await;
    let client = Client::new();
    let (status, auth) = post(
        &client,
        &base,
        "",
        "/auth/login",
        json!({"login": "latest-admin", "password": password}),
    )
    .await;
    assert!(status.is_success(), "{auth}");
    let token = auth["access_token"].as_str().unwrap();
    let (status, workspace) = post(
        &client,
        &base,
        token,
        "/workspaces",
        json!({"name": "latest"}),
    )
    .await;
    assert!(status.is_success(), "{workspace}");

    let busy = create_channel(&client, &base, token, &workspace, "busy").await;
    let quiet = create_channel(&client, &base, token, &workspace, "quiet").await;
    let left = create_channel(&client, &base, token, &workspace, "left").await;
    send(&client, &base, token, &busy, "first").await;
    send(&client, &base, token, &busy, "newest").await;
    send(&client, &base, token, &left, "hidden").await;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id = $1")
        .bind(&left)
        .execute(&db)
        .await
        .unwrap();

    let (status, body) = post(
        &client,
        &base,
        token,
        "/channels/latest-messages",
        json!({"channel_ids": [busy, quiet, left]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{body}");
    assert_eq!(messages[0]["channel_id"], json!(busy));
    assert_eq!(messages[0]["content"], "newest");

    let too_many: Vec<String> = (0..501).map(|_| Uuid::new_v4().to_string()).collect();
    let (status, _) = post(
        &client,
        &base,
        token,
        "/channels/latest-messages",
        json!({"channel_ids": too_many}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
