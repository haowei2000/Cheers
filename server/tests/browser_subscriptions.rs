//! A failed channel subscription must not interrupt the shared browser socket.
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

struct Fixture {
    _gateway: gateway::TestGateway,
    base: String,
    client: Client,
    token: String,
    user: Uuid,
    channel: Uuid,
}

impl Fixture {
    async fn start(db: &PgPool) -> Self {
        let password = Uuid::new_v4().to_string();
        let (gateway, base) = gateway::TestGateway::start(db, "socket-admin", &password).await;
        let client = Client::new();
        let response = client
            .post(format!("{base}/api/v1/auth/login"))
            .json(&json!({"login":"socket-admin","password":password}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let auth: Value = response.json().await.unwrap();
        let mut fixture = Self {
            _gateway: gateway,
            base,
            client,
            token: auth["access_token"].as_str().unwrap().to_string(),
            user: auth["user_id"].as_str().unwrap().parse().unwrap(),
            channel: Uuid::nil(),
        };
        let workspace = fixture.post("/workspaces", json!({"name":"socket"})).await;
        let channel = fixture
            .post(
                "/channels",
                json!({"workspace_id":workspace["workspace_id"],"name":"socket"}),
            )
            .await;
        fixture.channel = channel["channel_id"].as_str().unwrap().parse().unwrap();
        fixture
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        let response = self
            .client
            .post(format!("{}/api/v1{path}", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        body
    }

    async fn socket(&self) -> Socket {
        let (mut socket, _) =
            connect_async(format!("{}/ws", self.base.replacen("http:", "ws:", 1)))
                .await
                .unwrap();
        send(&mut socket, json!({"type":"auth","token":self.token})).await;
        assert_eq!(next(&mut socket).await["type"], "auth_ok");
        socket
    }
}

async fn send(socket: &mut Socket, frame: Value) {
    socket.send(Message::Text(frame.to_string())).await.unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("expected gateway frame")
            .expect("shared socket must remain open")
            .unwrap();
        match message {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Close(reason) => panic!("shared socket closed: {reason:?}"),
            _ => {}
        }
    }
}

async fn next_type(socket: &mut Socket, expected: &str) -> Value {
    loop {
        let frame = next(socket).await;
        if frame["type"] == expected {
            return frame;
        }
    }
}

async fn subscribe(socket: &mut Socket, channel: Uuid) {
    send(socket, json!({"type":"subscribe","channel_id":channel})).await;
    assert_eq!(
        next_type(socket, "subscribed").await["channel_id"],
        channel.to_string()
    );
}

#[sqlx::test]
async fn denied_channel_keeps_authorized_events_and_resource_requests_alive(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut socket = fixture.socket().await;
    subscribe(&mut socket, fixture.channel).await;

    let denied = Uuid::new_v4();
    send(&mut socket, json!({"type":"subscribe","channel_id":denied})).await;
    let error = next_type(&mut socket, "subscription_error").await;
    assert_eq!(error["channel_id"], denied.to_string());
    assert_eq!(error["code"], "PERMISSION_DENIED");
    assert_eq!(error["reason"], "not a channel member");

    let message = fixture
        .post(
            &format!("/channels/{}/messages", fixture.channel),
            json!({"content":"the authorized subscription survives"}),
        )
        .await;
    let event = next_type(&mut socket, "message").await;
    assert_eq!(event["channel_id"], fixture.channel.to_string());
    assert_eq!(event["data"]["msg_id"], message["msg_id"]);

    send(
        &mut socket,
        json!({"type":"resource_req","req_id":"after-denial","resource":"fs.ls",
               "params":{"channel_id":fixture.channel,"path":""}}),
    )
    .await;
    let response = next_type(&mut socket, "resource_res").await;
    assert_eq!(response["req_id"], "after-denial");
    assert_eq!(response["ok"], true, "{response}");
    send(&mut socket, json!({"type":"ping"})).await;
    assert_eq!(next_type(&mut socket, "pong").await["type"], "pong");
}

#[sqlx::test]
async fn repeated_subscribe_reauthorizes_without_duplicate_delivery(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut socket = fixture.socket().await;
    subscribe(&mut socket, fixture.channel).await;
    subscribe(&mut socket, fixture.channel).await;

    // Sending a second message after consuming the first reveals any duplicate
    // first-message delivery left in the socket, without a timing-based absence check.
    for content in ["first", "second"] {
        let message = fixture
            .post(
                &format!("/channels/{}/messages", fixture.channel),
                json!({"content":content}),
            )
            .await;
        assert_eq!(
            next_type(&mut socket, "message").await["data"]["msg_id"],
            message["msg_id"]
        );
    }

    // The connection's local subscription list still contains the channel.
    // A repeated subscribe must nevertheless consult current membership.
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id=$1 AND member_id=$2")
        .bind(fixture.channel.to_string())
        .bind(fixture.user.to_string())
        .execute(&db)
        .await
        .unwrap();
    send(
        &mut socket,
        json!({"type":"subscribe","channel_id":fixture.channel}),
    )
    .await;
    let error = next_type(&mut socket, "subscription_error").await;
    assert_eq!(error["channel_id"], fixture.channel.to_string());
    assert_eq!(error["code"], "PERMISSION_DENIED");
    send(&mut socket, json!({"type":"ping"})).await;
    assert_eq!(next_type(&mut socket, "pong").await["type"], "pong");
}

#[sqlx::test]
async fn membership_lookup_failure_is_scoped_and_distinct_from_denial(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut socket = fixture.socket().await;
    // This test has its own sqlx database; make the production membership query
    // fail while token auth and the socket remain valid.
    sqlx::query("ALTER TABLE channel_memberships RENAME TO unavailable_memberships")
        .execute(&db)
        .await
        .unwrap();
    send(
        &mut socket,
        json!({"type":"subscribe","channel_id":fixture.channel}),
    )
    .await;
    let error = next_type(&mut socket, "subscription_error").await;
    assert_eq!(error["channel_id"], fixture.channel.to_string());
    assert_eq!(error["code"], "INTERNAL_ERROR");
    assert_eq!(error["reason"], "internal error");
    send(&mut socket, json!({"type":"ping"})).await;
    assert_eq!(next_type(&mut socket, "pong").await["type"], "pong");

    // The HTTP router remains live too; no shared-socket auth failure occurred.
    assert_eq!(
        fixture
            .client
            .get(format!("{}/health", fixture.base))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn reauthentication_cannot_change_the_socket_identity(db: PgPool) {
    let fixture = Fixture::start(&db).await;
    let mut socket = fixture.socket().await;
    subscribe(&mut socket, fixture.channel).await;

    // Renewal for this socket's authenticated account is still accepted.
    send(&mut socket, json!({"type":"auth","token":fixture.token})).await;
    assert_eq!(
        next_type(&mut socket, "auth_ok").await["user_id"],
        fixture.user.to_string()
    );

    let peer = Uuid::new_v4();
    let login = format!("peer-{peer}");
    let password = Uuid::new_v4().to_string();
    let hash = bcrypt::hash(&password, 4).unwrap();
    sqlx::query("INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,$3)")
        .bind(peer.to_string())
        .bind(&login)
        .bind(hash)
        .execute(&db)
        .await
        .unwrap();
    let auth = fixture
        .post("/auth/login", json!({"login":login,"password":password}))
        .await;
    assert_eq!(auth["user_id"], peer.to_string());
    send(
        &mut socket,
        json!({"type":"auth","token":auth["access_token"]}),
    )
    .await;
    let error = next_type(&mut socket, "auth_err").await;
    assert_eq!(error["reason"], "cannot change authenticated user");
    let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match message {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4401),
        other => panic!("expected authentication close, received {other:?}"),
    }
}
